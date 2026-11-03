'use strict';

const {app, BrowserWindow, clipboard, dialog, ipcMain, shell} = require('electron');
const {homedir} = require('node:os');
const {basename, join, resolve} = require('node:path');
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
  const [application, loader, types, diagnostics, trust, images, archive] = await Promise.all([
    load('app/runtime.js'), load('config/loader.js'), load('config/types.js'), load('diagnostics/connection.js'), load('config/trust.js'),
    load('attachments/images.js'), load('storage/archive.js'),
  ]);
  return {...application, ...loader, ...types, ...diagnostics, ...trust, ...images, ...archive};
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

async function selectProfile(name, modelOverride) {
  if (!config) throw new Error('配置未加载，请检查配置文件');
  if (!workspace) throw new Error('请先选择并信任工作区');
  const profile = core.resolveProfileWithApiKey(config, name);
  if (!profile) throw new Error('请选择模型配置');
  await dispose();
  const next = await core.createApplicationRuntime({config, profileName: profile.name, workspace, ...(modelOverride ? {modelOverride} : {})});
  runtime = next;
  controller = next.controller;
  unsubscribe = controller.subscribe(state => {
    if (window && !window.isDestroyed()) window.webContents.send('bitori:state', state);
  });
  return currentSnapshot(next.warnings.join('\n'));
}

async function loadConfiguration() {
  try {
    config = core.loadConfig(undefined, workspace);
    core.configureApplicationLogging(config);
    startupError = undefined;
    return await currentSnapshot();
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    return snapshot(startupError);
  }
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
function archiveBaseName(title) {
  const safe = String(title || '会话').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().slice(0, 80);
  return safe || '会话';
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
  // 启动时只加载配置（展示 profile），不创建工作区运行时；工具需要用户先信任工作区。
  handle('bitori:init', () => config ? currentSnapshot(startupError) : loadConfiguration());
  handle('bitori:profile', (name, modelOverride) => changeContext(async () => {
    try {
      const override = typeof modelOverride === 'string' && modelOverride ? checkedText(modelOverride, '模型名称', 200) : undefined;
      return await selectProfile(checkedText(name, '配置名称', 200), override);
    }
    catch (error) { return currentSnapshot(error instanceof Error ? error.message : String(error)); }
  }));
  handle('bitori:models', async name => {
    if (!config) throw new Error('配置未加载');
    const wanted = checkedText(name, '配置名称', 200);
    const profile = config.profiles.find(item => item.name === wanted);
    if (!profile) return {models: [], error: `找不到配置：${wanted}`};
    if (!profile.apiKey) return {models: [], error: `请在 .env 中填写 ${profile.apiKeyVariable || 'API key'}`};
    const probe = await core.probeProfile(profile);
    if (!probe.ok) return {models: [], error: `${probe.error ? probe.error.code : 'network'}：${probe.error ? probe.error.message : ''}。${probe.guidance || ''}`};
    const listing = {models: probe.models || [], note: probe.note || '', latencyMs: probe.latencyMs, error: ''};
    if (probe.modelAvailable === false) {
      listing.error = `配置的模型 “${probe.model}” 不在可用列表。${probe.guidance || ''}`;
      listing.note = '';
    }
    return listing;
  });
  handle('bitori:workspace', () => changeContext(async () => {
    const result = await dialog.showOpenDialog(window, {title: '选择工作区', defaultPath: workspace || homedir(), properties: ['openDirectory']});
    if (result.canceled || !result.filePaths[0] || closing) return null;
    const choice = await dialog.showMessageBox(window, {type: 'warning', buttons: ['取消', '信任并打开'], defaultId: 0, cancelId: 0, message: '确认信任此工作区？', detail: '工作区配置和 Hook 可能在启动时运行命令，工具也可以读取此目录。'});
    if (choice.response !== 1 || closing) return null;
    workspace = result.filePaths[0];
    await core.trustWorkspace(workspace);
    return initialize();
  }));
  handle('bitori:choose-images', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp']}],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    if (result.filePaths.length > 4) throw new Error('最多附加 4 张图片');
    const attachments = [];
    for (const path of result.filePaths) {
      attachments.push(await core.loadImageAttachment(path));
      core.imageAttachmentsSchema.parse(attachments);
    }
    return core.imageAttachmentsSchema.parse(attachments);
  });
  handle('bitori:paste-image', () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const attachment = core.imageAttachmentFromBytes(new Uint8Array(image.toPNG()), 'clipboard.png');
    return core.imageAttachmentsSchema.parse([attachment])[0];
  });
  handle('bitori:send', (text, attachments) => {
    if (typeof text !== 'string' || text.length > 100000) throw new Error('消息无效');
    const checkedAttachments = core.imageAttachmentsSchema.parse(attachments === undefined ? [] : attachments);
    if (!text.trim() && checkedAttachments.length === 0) throw new Error('消息或图片附件不能为空');
    const active = activeController();
    const priorMessageIds = new Set(active.getState().messages.map(message => message.id));
    return active.sendMessage(text, checkedAttachments).then(result => {
      const next = active.getState();
      const accepted = next.messages.some(message => message.role === 'user' && !priorMessageIds.has(message.id));
      if (next.requestStatus === 'failed' && next.visibleError) throw new Error(next.visibleError);
      if (!accepted && next.visibleError) throw new Error(next.visibleError);
      return result;
    });
  });
  handle('bitori:cancel', () => activeController().cancelActiveRequest());
  handle('bitori:new-session', () => activeController().createSession());
  handle('bitori:switch-session', id => activeController().switchSession(checkedText(id, '会话 ID', 200)));
  handle('bitori:sessions', () => activeController().listSessions());
  handle('bitori:rename-session', (id, title) => {
    const checkedId = checkedText(id, '会话 ID', 200);
    const checkedTitle = checkedText(title, '会话标题', 120);
    return activeController().renameSession(checkedId, checkedTitle);
  });
  handle('bitori:delete-session', id => activeController().deleteSession(checkedText(id, '会话 ID', 200)));
  handle('bitori:export-session', () => {
    const active = activeController();
    return changeContext(async () => {
      const result = await dialog.showSaveDialog(window, {
        title: '导出当前会话',
        defaultPath: join(app.getPath('documents'), `${archiveBaseName(active.getState().session?.title)}.bitori-session`),
        filters: [{name: 'Bitori 会话归档', extensions: ['bitori-session']}],
      });
      if (result.canceled || !result.filePath || closing) return null;
      const conversation = await active.exportSession();
      await core.writeSessionArchive(result.filePath, conversation);
      return {ok: true, fileName: basename(result.filePath)};
    });
  });
  handle('bitori:import-session', () => {
    const active = activeController();
    return changeContext(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '导入会话',
        properties: ['openFile'],
        filters: [{name: 'Bitori 会话归档', extensions: ['bitori-session', 'json']}],
      });
      if (result.canceled || !result.filePaths[0] || closing) return null;
      const conversation = await core.readSessionArchive(result.filePaths[0]);
      await active.importSession(conversation);
      return {ok: true, fileName: basename(result.filePaths[0]), snapshot: await currentSnapshot()};
    });
  });
  handle('bitori:resume-interrupted-run', () => {
    const active = activeController();
    if (!active.getState().recovery) throw new Error('当前没有待恢复任务');
    return active.resumeInterruptedRun();
  });
  handle('bitori:commands', () => activeController().commandCatalog());
  handle('bitori:external', url => {
    if (typeof url !== 'string' || url.length > 2048) throw new Error('链接无效');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('链接无效'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') throw new Error('只允许打开 HTTP(S) 或邮件链接');
    return shell.openExternal(parsed.href);
  });
  handle('bitori:zoom', factor => {
    if (typeof factor !== 'number' || !Number.isFinite(factor)) throw new Error('缩放比例无效');
    return applyZoom(factor);
  });
  handle('bitori:approval', (decision, callId) => {
    const decisions = {allow_once: 'approved_once', allow_session: 'approved_session', allow_always: 'approved_permanent', deny: 'denied'};
    if (!(decision in decisions)) throw new Error('审批决定无效');
    const active = activeController();
    if (active.getState().approvalPrompt?.callId !== checkedText(callId, '工具调用 ID', 200)) throw new Error('审批已过期，请重新确认');
    active.resolveToolApproval(decisions[decision]);
  });
  handle('bitori:undo', path => {
    const wanted = path === undefined || path === null || path === '' ? undefined : checkedText(String(path), '文件路径', 1000);
    return activeController().undoLastEdit(wanted);
  });
}

function applyZoom(next) {
  if (!window || window.isDestroyed()) return 1;
  const clamped = Math.min(2, Math.max(0.6, Math.round(next * 10) / 10));
  window.webContents.setZoomFactor(clamped);
  window.webContents.send('bitori:zoom', clamped);
  return clamped;
}

async function start() {
  core = await loadCore();
  registerHandlers();
  window = new BrowserWindow({width: 1200, height: 800, minWidth: 720, minHeight: 520, show: false, title: 'Bitori', icon: join(__dirname, 'icon.png'), backgroundColor: '#1f1f1e', webPreferences: {preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Ctrl +/- 调整页面缩放；Ctrl+0 恢复 100%。
  window.webContents.on('before-input-event', (event, input) => {
    if ((input.type !== 'keyDown' && input.type !== 'rawKeyDown') || (!input.control && !input.meta) || input.alt) return;
    const factor = window.webContents.getZoomFactor();
    let next;
    if (input.key === '=' || input.key === '+') next = factor + 0.1;
    else if (input.key === '-') next = factor - 0.1;
    else if (input.key === '0') next = 1;
    else return;
    event.preventDefault();
    applyZoom(next);
  });
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
