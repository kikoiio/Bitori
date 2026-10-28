'use strict';

const $ = id => document.getElementById(id);
const ui = {
  workspace: $('workspace-path'), chooseWorkspace: $('choose-workspace'), profile: $('profile'),
  sessions: $('sessions'), newSession: $('new-session'), title: $('chat-title'), profileDetail: $('profile-detail'),
  status: $('request-status'), error: $('error'), messages: $('messages'), messageList: $('message-list'),
  approval: $('approval'), approvalEffect: $('approval-effect'), approvalTool: $('approval-tool'),
  approvalArguments: $('approval-arguments'), approvalRisk: $('approval-risk'), allow: $('allow'), deny: $('deny'),
  composer: $('composer'), input: $('input'), send: $('send'), cancel: $('cancel')
};

let profiles = [];
let sessions = [];
let state = null;
let workspace = '';
let configError = '';
let actionError = '';
let ready = false;
let changingContext = false;
let actionPending = false;
let sending = false;
let approvalPending = false;
let contextVersion = 0;
let listVersion = 0;
let listTimer = null;
let stateVersion = 0;
const expanded = new Set();

const statusLabels = {
  idle: '就绪', thinking: '正在思考', streaming: '正在回复', approving: '等待批准',
  executing_tools: '正在运行工具', cancelling: '正在停止', failed: '请求失败'
};
const toolStatusLabels = {
  queued: '等待运行', running: '运行中', succeeded: '已完成', failed: '失败',
  timed_out: '已超时', skipped: '已跳过', interrupted: '已中断'
};
const approvalStatusLabels = {pending: '等待批准', approved: '已批准', denied: '已拒绝', not_required: '无需批准'};
const effectLabels = {read: '读取', write: '写入', command: '执行命令'};
const isActive = () => Boolean(state && !['idle', 'failed'].includes(state.requestStatus));
const canChangeContext = () => ready && !changingContext && !actionPending && !sending && !isActive();

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}
function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}
function messageForError(error) {
  return error && typeof error.message === 'string' ? error.message : String(error || '操作失败');
}
function showError() {
  const errors = [configError, actionError, state && state.visibleError].filter(Boolean);
  ui.error.textContent = [...new Set(errors)].join('\n');
  ui.error.hidden = errors.length === 0;
}
function clearActionError() { actionError = ''; showError(); }
function setActionError(error) { actionError = messageForError(error); showError(); }
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
}

function renderProfiles() {
  const selected = state && state.profile ? state.profile.name : '';
  ui.profile.replaceChildren();
  if (!profiles.length || !selected) {
    const placeholder = element('option', '', profiles.length ? '请选择配置' : '没有可用配置');
    placeholder.value = '';
    ui.profile.append(placeholder);
  }
  for (const profile of profiles) {
    const option = element('option', '', profile.name);
    option.value = profile.name;
    ui.profile.append(option);
  }
  ui.profile.value = selected;
  if (ui.profile.selectedIndex < 0) ui.profile.value = '';
}
function renderSessions() {
  const focusedId = document.activeElement?.closest?.('[data-session-id]')?.dataset.sessionId;
  let focusedButton = null;
  ui.sessions.replaceChildren();
  if (!sessions.length) {
    ui.sessions.append(element('p', 'sidebar-empty', state && state.profile ? '暂无会话，点击新建开始。' : '选择配置后查看会话。'));
    return;
  }
  for (const session of sessions) {
    const button = element('button', 'session');
    button.type = 'button';
    button.dataset.sessionId = session.id;
    if (focusedId === session.id) focusedButton = button;
    button.disabled = !canChangeContext();
    if (state && state.session && state.session.id === session.id) button.setAttribute('aria-current', 'page');
    button.append(element('span', 'session-title', session.title || '新会话'));
    const time = dateText(session.updatedAt || session.createdAt);
    if (time) button.append(element('span', 'session-date', time));
    button.addEventListener('click', () => switchSession(session.id));
    ui.sessions.append(button);
  }
  if (focusedButton && !focusedButton.disabled) focusedButton.focus({preventScroll: true});
}
function details(label, content, key, className = 'details') {
  const node = element('details', className);
  node.dataset.detailKey = key;
  node.open = expanded.has(key);
  node.addEventListener('toggle', () => node.open ? expanded.add(key) : expanded.delete(key));
  node.append(element('summary', '', label));
  node.append(element('pre', className === 'tool' ? 'tool-content' : 'thinking-content', content));
  return node;
}
function renderTool(call) {
  const execution = toolStatusLabels[call.executionStatus] || call.executionStatus || '';
  const approval = approvalStatusLabels[call.approvalStatus] || call.approvalStatus || '';
  const label = ['工具：' + (call.toolName || '未知工具'), execution, approval].filter(Boolean).join(' · ');
  const args = call.argumentsText || stringify(call.arguments || {});
  const result = call.result ? '\n\n结果：\n' + stringify(call.result) : '';
  return details(label, '参数：\n' + args + result, 'tool:' + call.id, 'tool');
}
function renderMessages() {
  const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80;
  const previousTop = ui.messages.scrollTop;
  const focusedKey = document.activeElement?.closest?.('details[data-detail-key]')?.dataset.detailKey;
  ui.messageList.replaceChildren();
  const messages = state && Array.isArray(state.messages) ? state.messages : [];
  const calls = state && Array.isArray(state.toolCalls) ? state.toolCalls : [];
  if (!messages.length && !calls.length) {
    const empty = element('div', 'empty');
    empty.append(element('strong', '', state && state.profile ? '开始新对话' : '选择配置开始聊天'));
    empty.append(element('span', '', state && state.profile ? '在下方输入消息，开始与模型交流。' : '请选择并信任工作区，再选择配置。'));
    ui.messageList.append(empty);
  }
  const usedCalls = new Set();
  for (const message of messages) {
    const article = element('article', 'message ' + (message.role === 'user' ? 'user' : 'assistant'));
    const heading = element('div', 'message-heading');
    const role = message.role === 'user' ? '你' : message.role === 'assistant' ? '助手' : message.role || '消息';
    heading.append(element('span', '', role));
    const messageStatus = {streaming: '生成中', cancelled: '已停止', failed: '失败'}[message.status];
    if (messageStatus) heading.append(element('span', 'message-meta', messageStatus));
    article.append(heading);
    if (message.thinking) article.append(details('思考过程', message.thinking, 'thinking:' + message.id));
    if (message.displayContent ?? message.content) article.append(element('div', 'message-body', message.displayContent ?? message.content));
    else if (message.status === 'streaming' && !message.thinking) article.append(element('div', 'message-meta', '正在生成…'));
    if (message.errorMessage) article.append(element('div', 'message-error', message.errorMessage));
    for (const call of calls) {
      if (call.assistantMessageId === message.id) {
        article.append(renderTool(call));
        usedCalls.add(call.id);
      }
    }
    ui.messageList.append(article);
  }
  for (const call of calls) if (!usedCalls.has(call.id)) ui.messageList.append(renderTool(call));
  ui.messages.scrollTop = nearBottom ? ui.messages.scrollHeight : previousTop;
  if (focusedKey) {
    const focusedDetails = Array.from(ui.messageList.querySelectorAll('details[data-detail-key]'))
      .find(node => node.dataset.detailKey === focusedKey);
    focusedDetails?.querySelector('summary')?.focus({preventScroll: true});
  }
}
function renderApproval() {
  const prompt = state && state.approvalPrompt;
  ui.approval.hidden = !prompt;
  if (!prompt) return;
  ui.approvalEffect.textContent = effectLabels[prompt.effect] || prompt.effect || '';
  ui.approvalTool.textContent = '工具：' + (prompt.toolName || '未知工具');
  ui.approvalArguments.textContent = prompt.argumentSummary || '无参数';
  const risk = [prompt.riskMessage, prompt.reason].filter(Boolean).join('\n');
  ui.approvalRisk.textContent = risk;
  ui.approvalRisk.hidden = !risk;
}
function renderControls() {
  const canChange = canChangeContext();
  ui.chooseWorkspace.disabled = !canChange;
  ui.profile.disabled = !canChange || !profiles.length;
  ui.newSession.disabled = !canChange || !(state && state.profile);
  const active = isActive();
  ui.input.disabled = !ready || changingContext || !(state && state.profile);
  ui.send.disabled = ui.input.disabled || active || sending || actionPending || !ui.input.value.trim();
  ui.cancel.hidden = !active;
  ui.cancel.disabled = state && state.requestStatus === 'cancelling';
  ui.allow.disabled = ui.deny.disabled = approvalPending || changingContext;
  ui.status.textContent = changingContext ? '正在加载' : !ready ? '正在连接' : state ? (statusLabels[state.requestStatus] || state.requestStatus || '就绪') : '等待配置';
  renderSessions();
}
function render() {
  ui.workspace.textContent = workspace || '未选择工作区';
  ui.workspace.title = workspace || '未选择工作区';
  ui.title.textContent = state && state.session && state.session.title || '聊天';
  const profile = state && state.profile;
  ui.profileDetail.textContent = profile ? [profile.name, profile.protocol, profile.model].filter(Boolean).join(' · ') : '请选择配置';
  renderProfiles();
  renderMessages();
  renderApproval();
  showError();
  renderControls();
}
function applySnapshot(snapshot) {
  profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
  workspace = typeof snapshot.workspace === 'string' ? snapshot.workspace : '';
  state = snapshot.state || null;
  sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  configError = snapshot.error || '';
  contextVersion++;
  listVersion++;
  clearTimeout(listTimer);
  expanded.clear();
  render();
}
async function refreshSessions() {
  if (!ready || changingContext || !state || !state.profile) return;
  const context = contextVersion;
  const request = ++listVersion;
  try {
    const result = await window.bitori.listSessions();
    if (context !== contextVersion || request !== listVersion || changingContext) return;
    if (Array.isArray(result)) { sessions = result; renderSessions(); }
  } catch (error) {
    if (context === contextVersion && request === listVersion && !changingContext) setActionError(error);
  }
}
function scheduleSessionRefresh() {
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshSessions, 350);
}
async function changeContext(operation) {
  if (!canChangeContext()) return;
  changingContext = true;
  clearActionError();
  renderControls();
  try {
    const snapshot = await operation();
    if (snapshot) applySnapshot(snapshot);
  } catch (error) { setActionError(error); }
  finally { changingContext = false; render(); }
}
async function sessionAction(operation) {
  if (!canChangeContext()) return;
  actionPending = true;
  clearActionError();
  renderControls();
  try { await operation(); await refreshSessions(); }
  catch (error) { setActionError(error); }
  finally { actionPending = false; renderControls(); }
}
function switchSession(id) {
  if (state && state.session && state.session.id === id) return;
  sessionAction(() => window.bitori.switchSession(id));
}
async function decide(decision) {
  if (!state || !state.approvalPrompt || approvalPending) return;
  approvalPending = true;
  clearActionError();
  renderControls();
  try { await window.bitori.decideApproval(decision, state.approvalPrompt.callId); }
  catch (error) { setActionError(error); }
  finally { approvalPending = false; renderControls(); }
}

ui.profile.addEventListener('change', () => {
  const name = ui.profile.value;
  if (name && (!state || !state.profile || state.profile.name !== name)) changeContext(() => window.bitori.selectProfile(name));
});
ui.chooseWorkspace.addEventListener('click', () => changeContext(() => window.bitori.chooseWorkspace()));
ui.newSession.addEventListener('click', () => sessionAction(() => window.bitori.newSession()));
ui.allow.addEventListener('click', () => decide('allow'));
ui.deny.addEventListener('click', () => decide('deny'));
ui.cancel.addEventListener('click', async () => {
  clearActionError();
  ui.cancel.disabled = true;
  try { await window.bitori.cancel(); }
  catch (error) { setActionError(error); }
  finally { renderControls(); }
});
ui.input.addEventListener('input', renderControls);
ui.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if (!ui.send.disabled) ui.composer.requestSubmit();
  }
});
ui.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if (!text || ui.send.disabled) return;
  sending = true;
  clearActionError();
  ui.input.value = '';
  renderControls();
  try { await window.bitori.send(text); }
  catch (error) {
    if (!ui.input.value) ui.input.value = text;
    setActionError(error);
  } finally { sending = false; renderControls(); scheduleSessionRefresh(); }
});

async function start() {
  if (!window.bitori) {
    configError = '无法连接桌面服务，请重新启动应用。';
    showError();
    return;
  }
  try {
    const unsubscribe = window.bitori.onState(next => {
      stateVersion++;
      state = next;
      render();
      scheduleSessionRefresh();
    });
    if (typeof unsubscribe === 'function') window.addEventListener('beforeunload', unsubscribe, {once: true});
    const version = stateVersion;
    const snapshot = await window.bitori.init();
    const pushedState = stateVersion !== version ? state : null;
    applySnapshot(snapshot);
    if (stateVersion !== version) { state = pushedState; render(); }
    ready = true;
    render();
    scheduleSessionRefresh();
  } catch (error) { configError = messageForError(error); showError(); }
}
renderControls();
start();
