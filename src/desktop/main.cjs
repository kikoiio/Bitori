'use strict';

const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const {homedir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');

let window;
let controller;
let toolSystem;
let config;
let unsubscribe;
let workspace = app.isPackaged ? homedir() : process.cwd();
let closing = false;
let switching = false;
let core;
let startupError;

async function loadCore() {
  const base = resolve(__dirname, '../../dist');
  const load = name => import(pathToFileURL(join(base, name)).href);
  const [chat, loader, types, providers, storage, tools, logging, redaction, retention] = await Promise.all([
    load('chat/agent-controller.js'), load('config/loader.js'), load('config/types.js'),
    load('providers/factory.js'), load('storage/repository.js'), load('tools/create-tool-system.js'),
    load('shared/logger.js'), load('shared/redact.js'), load('trace/retention.js'),
  ]);
  return {...chat, ...loader, ...types, ...providers, ...storage, ...tools, ...logging, ...redaction, ...retention};
}

async function dispose() {
  unsubscribe?.();
  unsubscribe = undefined;
  const previous = controller;
  controller = undefined;
  try { if (previous) await previous.shutdown(); }
  finally { toolSystem?.close(); toolSystem = undefined; }
}

function snapshot(error) {
  return {
    profiles: config ? config.profiles.map(core.toProfileSummary) : [],
    workspace,
    state: controller?.getState() ?? null,
    sessions: [],
    ...(error ? {error} : {}),
  };
}

async function currentSnapshot(error) {
  const result = snapshot(error);
  if (controller) result.sessions = await controller.listSessions();
  return result;
}

async function selectProfile(name) {
  if (!config) throw new Error('配置未加载，请检查配置文件');
  const profile = core.resolveProfileWithApiKey(config, name);
  if (!profile) throw new Error('请选择模型配置');
  await dispose();
  const cache = new Map();
  const clientFor = model => {
    const requested = model === null ? profile.name : (config.models[model] ?? model);
    const chosen = config.profiles.find(item => item.name === requested) ?? profile;
    if (!cache.has(chosen.name)) cache.set(chosen.name, core.createLLMClient(chosen));
    return cache.get(chosen.name);
  };
  toolSystem = core.createToolSystem(workspace, config.mcpServers, {clientFor, memoryClient: core.createLLMClient(profile)});
  try {
    const result = await toolSystem.mcp.initialize();
    await toolSystem.services.hooks.fire('startup', {event: 'startup'});
    const repository = new core.SessionRepository();
    const paths = core.configPaths();
    const next = new core.ChatController(core.createLLMClient(profile), repository, toolSystem, undefined, {
      observability: {traceDirectory: paths.traces, usagePath: join(paths.usage, 'skills.jsonl')},
    });
    try { await next.initialize(profile); }
    catch (error) { await repository.close().catch(() => {}); throw error; }
    controller = next;
    unsubscribe = next.subscribe(state => {
      if (window && !window.isDestroyed()) window.webContents.send('bitori:state', state);
    });
    const warning = result.failed.map(item => `MCP ${item.name}：${item.error.message}`).join('\n');
    return currentSnapshot(warning);
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function initialize() {
  await dispose();
  config = undefined;
  startupError = undefined;
  try {
    process.chdir(workspace);
    config = core.loadConfig(undefined, workspace);
    const paths = core.configPaths();
    const redactor = core.createRedactor(core.collectSecretValues(config));
    core.setGlobalRedactor(redactor);
    core.configureLogging({directory: paths.logs, redactor, ...config.logging.level && {level: config.logging.level}, ...config.logging.retention_days && {retentionDays: config.logging.retention_days}});
    core.cleanupExpiredTraces(paths.traces, config.trace.retention_days ?? 30);
    if (config.profiles.length === 1) {
      const result = await selectProfile(config.profiles[0].name);
      startupError = result.error;
      return result;
    }
    return currentSnapshot();
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    return snapshot(startupError);
  }
}

function activeController() {
  if (!controller) throw new Error('请先选择模型配置');
  return controller;
}
function requireIdle() {
  const state = controller?.getState();
  if (state && !['idle', 'failed'].includes(state.requestStatus)) throw new Error('请先停止当前任务');
}
function checkedText(value, name, max = 100000) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name}无效`);
  return value;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的请求来源');
    return fn(...args);
  });
}

function registerHandlers() {
  handle('bitori:init', () => currentSnapshot(startupError));
  handle('bitori:profile', async name => {
    requireIdle();
    if (switching) throw new Error('正在切换配置');
    switching = true;
    try { return await selectProfile(checkedText(name, '配置名称', 200)); }
    finally { switching = false; }
  });
  handle('bitori:workspace', async () => {
    requireIdle();
    if (switching) throw new Error('正在切换工作区');
    switching = true;
    try {
      const result = await dialog.showOpenDialog(window, {title: '选择工作区', defaultPath: workspace, properties: ['openDirectory']});
      if (result.canceled || !result.filePaths[0]) return null;
      const choice = await dialog.showMessageBox(window, {type: 'warning', buttons: ['取消', '信任并打开'], defaultId: 0, cancelId: 0, message: '确认信任此工作区？', detail: '工作区配置可能在启动时运行 MCP 命令，工具也可以读取此目录。'});
      if (choice.response !== 1) return null;
      workspace = result.filePaths[0];
      return await initialize();
    } finally { switching = false; }
  });
  handle('bitori:send', text => activeController().sendMessage(checkedText(text, '消息')));
  handle('bitori:cancel', () => activeController().cancelActiveRequest());
  handle('bitori:new-session', () => activeController().createSession());
  handle('bitori:switch-session', id => activeController().switchSession(checkedText(id, '会话 ID', 200)));
  handle('bitori:sessions', () => activeController().listSessions());
  handle('bitori:approval', decision => {
    if (decision !== 'allow' && decision !== 'deny') throw new Error('审批决定无效');
    activeController().resolveToolApproval(decision === 'allow' ? 'approved_once' : 'denied');
  });
}

async function start() {
  core = await loadCore();
  registerHandlers();
  window = new BrowserWindow({width: 1200, height: 800, minWidth: 720, minHeight: 520, show: false, title: 'Bitori', backgroundColor: '#f4f6fa', webPreferences: {preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void dispose().finally(() => app.quit());
  });
  await initialize();
  await window.loadFile(join(__dirname, 'renderer/index.html'));
  window.show();
}

app.whenReady().then(start).catch(error => {
  dialog.showErrorBox('Bitori 无法启动', error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
