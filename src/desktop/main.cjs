'use strict';

const {app, BrowserWindow, dialog, ipcMain} = require('electron');
const {homedir} = require('node:os');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');

let window;
let controller;
let runtime;
let config;
let unsubscribe;
let workspace = '';
let closing = false;
let switching = false;
let pendingSwitch = Promise.resolve();
let core;
let startupError;

async function loadCore() {
  const base = resolve(__dirname, '../../dist');
  const load = name => import(pathToFileURL(join(base, name)).href);
  const [application, loader, types] = await Promise.all([
    load('app/runtime.js'), load('config/loader.js'), load('config/types.js'),
  ]);
  return {...application, ...loader, ...types};
}

async function dispose() {
  unsubscribe?.();
  unsubscribe = undefined;
  controller = undefined;
  const previous = runtime;
  runtime = undefined;
  if (previous) await previous.close();
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
  const next = await core.createApplicationRuntime({config, profileName: profile.name, workspace});
  runtime = next;
  controller = next.controller;
  unsubscribe = controller.subscribe(state => {
    if (window && !window.isDestroyed()) window.webContents.send('bitori:state', state);
  });
  return currentSnapshot(next.warnings.join('\n'));
}

async function initialize() {
  await dispose();
  config = undefined;
  startupError = undefined;
  try {
    config = core.loadConfig(undefined, workspace);
    core.configureApplicationLogging(config);
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
  if (closing || switching) throw new Error('正在切换或关闭');
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

async function changeContext(operation) {
  requireIdle();
  if (closing || switching) throw new Error('正在切换或关闭');
  switching = true;
  const operationPromise = operation();
  pendingSwitch = operationPromise.catch(() => {});
  try { return await operationPromise; }
  finally { switching = false; }
}

function registerHandlers() {
  handle('bitori:init', () => currentSnapshot(startupError));
  handle('bitori:profile', name => changeContext(async () => {
    try { return await selectProfile(checkedText(name, '配置名称', 200)); }
    catch (error) { return currentSnapshot(error instanceof Error ? error.message : String(error)); }
  }));
  handle('bitori:workspace', () => changeContext(async () => {
    const result = await dialog.showOpenDialog(window, {title: '选择工作区', defaultPath: workspace || homedir(), properties: ['openDirectory']});
    if (result.canceled || !result.filePaths[0] || closing) return null;
    const choice = await dialog.showMessageBox(window, {type: 'warning', buttons: ['取消', '信任并打开'], defaultId: 0, cancelId: 0, message: '确认信任此工作区？', detail: '工作区配置和 Hook 可能在启动时运行命令，工具也可以读取此目录。'});
    if (choice.response !== 1 || closing) return null;
    workspace = result.filePaths[0];
    return initialize();
  }));
  handle('bitori:send', text => activeController().sendMessage(checkedText(text, '消息')));
  handle('bitori:cancel', () => activeController().cancelActiveRequest());
  handle('bitori:new-session', () => activeController().createSession());
  handle('bitori:switch-session', id => activeController().switchSession(checkedText(id, '会话 ID', 200)));
  handle('bitori:sessions', () => activeController().listSessions());
  handle('bitori:approval', (decision, callId) => {
    if (decision !== 'allow' && decision !== 'deny') throw new Error('审批决定无效');
    const active = activeController();
    if (active.getState().approvalPrompt?.callId !== checkedText(callId, '工具调用 ID', 200)) throw new Error('审批已过期，请重新确认');
    active.resolveToolApproval(decision === 'allow' ? 'approved_once' : 'denied');
  });
}

async function start() {
  core = await loadCore();
  registerHandlers();
  window = new BrowserWindow({width: 1200, height: 800, minWidth: 720, minHeight: 520, show: false, title: 'Bitori', icon: join(__dirname, 'icon.png'), backgroundColor: '#f4f6fa', webPreferences: {preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void pendingSwitch.then(dispose).finally(() => app.quit());
  });
  await window.loadFile(join(__dirname, 'renderer/index.html'));
  window.show();
}

app.whenReady().then(start).catch(error => {
  dialog.showErrorBox('Bitori 无法启动', error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
