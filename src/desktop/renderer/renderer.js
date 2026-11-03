'use strict';

const $ = id => document.getElementById(id);
const ui = {
  workspace: $('workspace-path'), workspaceName: $('workspace-name'), chooseWorkspace: $('choose-workspace'), profile: $('profile'),
  sessions: $('sessions'), sessionCount: $('session-count'), newSession: $('new-session'), title: $('chat-title'), profileDetail: $('profile-detail'),
  importSession: $('import-session'), exportSession: $('export-session'), sessionFeedback: $('session-feedback'),
  status: $('request-status'), error: $('error'), messages: $('messages'), messageList: $('message-list'),
  approval: $('approval'), approvalEffect: $('approval-effect'), approvalTool: $('approval-tool'),
  approvalDetail: $('approval-detail'), approvalRisk: $('approval-risk'),
  recovery: $('recovery'), recoveryMessage: $('recovery-message'), recoveryNote: $('recovery-note'), recoveryContinue: $('recovery-continue'),
  deny: $('deny'), allowOnce: $('allow-once'), allowSession: $('allow-session'), allowAlways: $('allow-always'),
  composer: $('composer'), input: $('input'), send: $('send'), cancel: $('cancel'), composerPlus: $('composer-plus'),
  chooseImages: $('choose-images'), pasteImage: $('paste-image'), attachmentDrafts: $('attachment-drafts'),
  slashMenu: $('slash-menu'), modelMenu: $('model-menu'), modelButton: $('model-button'), modelName: $('model-name'),
  composerProfile: $('composer-profile'), composerMode: $('composer-mode'), composerPermission: $('composer-permission'),
  composerHelp: $('composer-help'), usageValue: $('usage-value'), zoomBadge: $('zoom-badge'), sessionSearch: $('session-search')
};

let profiles = [];
let sessions = [];
let state = null;let workspace = '';
let configError = '';
let actionError = '';
let ready = false;
let changingContext = false;
let actionPending = false;
let sending = false;
let approvalPending = false;
let attachmentActionPending = false;
let recoveryPending = false;
let draftAttachments = [];
let attachmentScope = '';
let contextVersion = 0;
let listVersion = 0;
let listTimer = null;
let stateVersion = 0;
const expanded = new Set();
const collapsed = new Set();
let commandCatalog = [];
let slashOpen = false;
let slashItems = [];
let slashIndex = 0;
let modelMenuOpen = false;
let modelState = null;
let sessionFilter = '';
let renamingSessionId = null;
let renameDraft = '';
let deleteArmedSessionId = null;
let rebuildingSessionList = false;
let zoomTimer = null;
let currentZoom = 1;

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
const toolNames = {
  read_file: 'Read', edit_file: 'Update', write_file: 'Write', run_command: 'Bash',
  search_text: 'Search', find_files: 'Glob', agent: 'Agent'
};
const toolIcons = {
  read_file: '◧', edit_file: '✎', write_file: '＋', run_command: '⌘',
  search_text: '⌕', find_files: '✦', agent: '◇'
};
const UI_COMMANDS = [
  {name: 'model', description: '切换模型配置', argumentHint: '<name>', aliases: []},
  {name: 'new', description: '新建会话', aliases: []},
  {name: 'sessions', description: '聚焦会话列表', aliases: []},
  {name: 'help', description: '浏览全部命令', aliases: []},
  {name: 'clear', description: '清空当前输入', aliases: []}
];

const isActive = () => Boolean(state && !['idle', 'failed'].includes(state.requestStatus));
const canChangeWorkspace = () => ready && !changingContext && !actionPending && !sending && !isActive();
const canChangeContext = () => canChangeWorkspace() && Boolean(workspace);
const canUseSession = () => canChangeContext() && Boolean(state && state.profile);
function contextBlockReason() {
  if (!ready) return '正在连接';
  if (changingContext) return '正在加载';
  if (actionPending || sending) return '正在处理其他操作';
  if (isActive()) return '请先停止当前任务';
  if (!workspace) return '请先选择并信任工作区';
  if (!state || !state.profile) return '请选择模型配置';
  return '';
}

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
function setSessionFeedback(message, kind = '') {
  ui.sessionFeedback.textContent = message;
  ui.sessionFeedback.className = `session-feedback${kind ? ` ${kind}` : ''}`;
  ui.sessionFeedback.hidden = !message;
}
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
}
function baseName(path) {
  if (!path) return '未选择工作区';
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || path;
}
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
function imageAttachmentByteLength(image) {
  if (!image || typeof image.data !== 'string' || image.data.length === 0 || image.data.length > MAX_IMAGE_BASE64_LENGTH || image.data.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) return null;
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
  const byteLength = image.data.length / 4 * 3 - padding;
  return byteLength > 0 && byteLength <= MAX_IMAGE_BYTES ? byteLength : null;
}
function isDisplayableImageAttachment(image) {
  return Boolean(image && typeof image.name === 'string' && IMAGE_MEDIA_TYPES.has(image.mediaType) && imageAttachmentByteLength(image) !== null);
}
function imageDataUrl(image) { return `data:${image.mediaType};base64,${image.data}`; }
function attachmentScopeForState() {
  if (!workspace || !state || !state.profile || !state.session) return '';
  return `${workspace}\u0000${state.profile.name}\u0000${state.session.id}`;
}
function syncAttachmentScope() {
  const next = attachmentScopeForState();
  if (next === attachmentScope) return;
  attachmentScope = next;
  draftAttachments = [];
  renderDraftAttachments();
}
function renderImageAttachment(image, className) {
  if (!isDisplayableImageAttachment(image)) return null;
  const img = element('img', className);
  img.src = imageDataUrl(image);
  img.alt = image.name || '图片附件';
  img.dataset.attachmentName = image.name;
  img.loading = 'lazy';
  img.decoding = 'async';
  return img;
}
function renderMessageAttachments(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const list = element('div', 'message-attachments');
  for (const image of images) {
    const img = renderImageAttachment(image, 'message-attachment');
    if (!img) continue;
    const item = element('div', 'message-attachment-item');
    item.append(img, element('span', 'message-attachment-name', image.name || '图片附件'));
    list.append(item);
  }
  return list.childElementCount ? list : null;
}
function renderDraftAttachments() {
  ui.attachmentDrafts.replaceChildren();
  ui.attachmentDrafts.hidden = draftAttachments.length === 0;
  draftAttachments.forEach((image, index) => {
    const img = renderImageAttachment(image, '');
    if (!img) return;
    const preview = element('div', 'attachment-preview');
    img.alt = '';
    preview.append(img, element('span', 'attachment-preview-name', image.name || '图片附件'));
    const remove = element('button', 'attachment-remove', '×');
    remove.type = 'button';
    remove.title = `移除图片 ${image.name || index + 1}`;
    remove.setAttribute('aria-label', `移除图片 ${image.name || index + 1}`);
    remove.dataset.removeAttachment = String(index);
    remove.disabled = !canUseSession() || attachmentActionPending;
    remove.addEventListener('click', () => {
      if (!canUseSession() || attachmentActionPending) return;
      draftAttachments = draftAttachments.filter((_attachment, itemIndex) => itemIndex !== index);
      renderDraftAttachments();
      renderControls();
    });
    preview.append(remove);
    ui.attachmentDrafts.append(preview);
  });
}
function addDraftAttachments(value) {
  const additions = Array.isArray(value) ? value : value ? [value] : [];
  if (additions.length === 0) return;
  if (additions.some(image => !isDisplayableImageAttachment(image))) throw new Error('收到无效的图片附件');
  const next = [...draftAttachments, ...additions];
  if (next.length > 4) throw new Error('最多附加 4 张图片');
  const totalBytes = next.reduce((total, image) => total + imageAttachmentByteLength(image), 0);
  if (totalBytes > 8 * 1024 * 1024) throw new Error('图片附件总大小不能超过 8 MiB');
  draftAttachments = next;
  renderDraftAttachments();
  renderControls();
}
async function chooseImages() {
  if (!canUseSession()) { setActionError(contextBlockReason()); return; }
  attachmentActionPending = true;
  clearActionError();
  renderControls();
  try { addDraftAttachments(await window.bitori.chooseImages()); }
  catch (error) { setActionError(error); }
  finally { attachmentActionPending = false; renderDraftAttachments(); renderControls(); }
}
async function pasteImage() {
  if (!canUseSession()) { setActionError(contextBlockReason()); return; }
  attachmentActionPending = true;
  clearActionError();
  renderControls();
  try {
    const image = await window.bitori.pasteImage();
    if (!image) throw new Error('剪贴板中没有图片');
    addDraftAttachments(image);
  } catch (error) { setActionError(error); }
  finally { attachmentActionPending = false; renderDraftAttachments(); renderControls(); }
}
/** 与 TUI src/shared/usage-format.ts 同语义:credits-only 用量不得显示成 0 tokens。 */
function formatUsage(usage) {
  if (!usage) return 'tokens —';
  const credits = usage.credits === undefined || usage.credits === 0 ? '' : `credits ${String(usage.credits.toFixed(2)).replace(/\.?0+$/, '')}`;
  const hasTokens = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (!hasTokens) return credits || 'tokens —';
  const cache = (usage.cacheReadInputTokens ?? 0) > 0 ? ` · cache ${usage.cacheReadInputTokens}` : '';
  const tokens = `tokens ${usage.inputTokens}↓ ${usage.outputTokens}↑${cache}`;
  return credits ? `${tokens} · ${credits}` : tokens;
}

function permissionLabel(tier) {
  if (tier === 'strict') return '严格权限';
  if (tier === 'bypass') return '放行权限';
  return '默认权限';
}
function durationLabel(call) {
  const elapsed = call.updatedAt - call.createdAt;
  if (!Number.isFinite(elapsed) || elapsed < 100) return '';
  return elapsed >= 10000 ? `${Math.round(elapsed / 1000)}s` : `${(elapsed / 1000).toFixed(1)}s`;
}
function toolDisplay(name) { return toolNames[name] || name || '工具'; }
function toolIcon(name) { return toolIcons[name] || '•'; }

/**
 * 行级 diff —— 与 TUI src/tui/diff.ts 同语义(渲染器是严格 CSP 的普通脚本,无法 import TS 模块)。
 * 先裁剪公共前后缀,再对中间段做 LCS;过大时退回整块替换,保持诚实而不是伪造逐行对齐。
 */
function splitDiffLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function diffLines(oldText, newText) {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld -= 1; endNew -= 1; }
  const middleOld = oldLines.slice(start, endOld);
  const middleNew = newLines.slice(start, endNew);
  const rows = [];
  for (let index = 0; index < start; index += 1) rows.push({kind: 'context', text: oldLines[index]});
  if (middleOld.length * middleNew.length > 400_000) {
    for (const text of middleOld) rows.push({kind: 'remove', text});
    for (const text of middleNew) rows.push({kind: 'add', text});
  } else {
    const width = middleNew.length + 1;
    const table = new Uint32Array((middleOld.length + 1) * width);
    for (let i = middleOld.length - 1; i >= 0; i -= 1) {
      for (let j = middleNew.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = middleOld[i] === middleNew[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < middleOld.length && j < middleNew.length) {
      if (middleOld[i] === middleNew[j]) { rows.push({kind: 'context', text: middleOld[i]}); i += 1; j += 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { rows.push({kind: 'remove', text: middleOld[i]}); i += 1; }
      else { rows.push({kind: 'add', text: middleNew[j]}); j += 1; }
    }
    while (i < middleOld.length) { rows.push({kind: 'remove', text: middleOld[i]}); i += 1; }
    while (j < middleNew.length) { rows.push({kind: 'add', text: middleNew[j]}); j += 1; }
  }
  for (let index = endOld; index < oldLines.length; index += 1) rows.push({kind: 'context', text: oldLines[index]});
  return rows;
}
function editInfo(call) {
  let args = call.arguments;
  if (!args || typeof args !== 'object') {
    try { args = JSON.parse(call.argumentsText || '{}'); } catch { return null; }
  }
  if (!args || typeof args !== 'object') return null;
  const path = typeof args.path === 'string' ? args.path : '';
  if (call.toolName === 'edit_file' && typeof args.oldText === 'string' && typeof args.newText === 'string') return {path, oldText: args.oldText, newText: args.newText};
  if (call.toolName === 'write_file' && typeof args.content === 'string') return {path, oldText: '', newText: args.content};
  return null;
}
function diffCounts(rows) {
  let added = 0; let removed = 0;
  for (const row of rows) { if (row.kind === 'add') added += 1; else if (row.kind === 'remove') removed += 1; }
  return {added, removed};
}
function renderDiffNode(edit, maxRows = 60) {
  const rows = diffLines(edit.oldText, edit.newText);
  const {added, removed} = diffCounts(rows);
  const block = element('div', 'diff');
  block.append(element('div', 'diff-summary', `${edit.path || '目标文件'} · +${added} −${removed}`));
  const shown = rows.filter(row => row.kind !== 'context').length > maxRows
    ? rows.slice(0, maxRows)
    : rows;
  for (const row of shown) {
    const line = element('div', `diff-row diff-${row.kind}`);
    line.append(element('span', 'diff-sign', row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '));
    line.append(element('span', 'diff-text', row.text));
    block.append(line);
  }
  if (shown.length < rows.length) block.append(element('div', 'diff-more', `… 还有 ${rows.length - shown.length} 行,展开查看`));
  return {node: block, added, removed, rows};
}
function primaryArgument(call) {
  const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  for (const key of ['path', 'command', 'query', 'pattern', 'agent', 'file', 'filename']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      const value = args[key].trim().split('\n')[0];
      return value.length > 64 ? `${value.slice(0, 63)}…` : value;
    }
  }
  const first = Object.values(args).find(value => typeof value === 'string' && value.trim());
  if (typeof first === 'string') return first.length > 64 ? `${first.slice(0, 63)}…` : first;
  return '';
}
function liveArgument(tool) {
  try {
    const args = JSON.parse(tool.argumentsText || '{}');
    if (args && typeof args === 'object') {
      const value = primaryArgument({arguments: args});
      if (value) return value;
    }
  } catch { /* 参数仍在流式中。 */ }
  const compact = String(tool.argumentsText || '').trim().replace(/\s+/g, ' ');
  return compact ? (compact.length > 64 ? `${compact.slice(0, 63)}…` : compact) : '…';
}
function toolResultText(call) {
  const result = call.result;
  if (!result) return '';
  if (result.status !== 'success') return result.error && result.error.message ? result.error.message : '执行失败';
  const output = result.output;
  if (output && typeof output === 'object') {
    const stdout = typeof output.stdout === 'string' ? output.stdout : '';
    const stderr = typeof output.stderr === 'string' ? output.stderr : '';
    if (stdout || stderr) return [stdout, stderr].filter(Boolean).join('\n').trim() || '(无输出)';
    if (typeof output.content === 'string') return output.content;
    if (typeof output.output === 'string') return output.output;
    if (Array.isArray(output.matches)) return output.matches.map(match => typeof match === 'string' ? match : stringify(match)).join('\n') || '(无匹配)';
    if (Array.isArray(output.files)) return output.files.join('\n') || '(无文件)';
    return stringify(output);
  }
  return output === undefined || output === null ? '(无输出)' : stringify(output);
}

function renderProfiles() {
  const selected = state && state.profile ? state.profile.name : '';
  ui.profile.replaceChildren();
  if (!profiles.length || !selected) {
    const placeholder = element('option', '', profiles.length ? '请选择配置' : '没有可用配置 — 运行 bitori doctor 检查');
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
  const activeElement = document.activeElement;
  const activeRenameInput = activeElement?.matches?.('.session-rename-input') && ui.sessions.contains(activeElement) ? activeElement : null;
  const needle = sessionFilter.trim().toLowerCase();
  const visible = needle ? sessions.filter(session => String(session.title || '新会话').toLowerCase().includes(needle)) : sessions;
  ui.sessionCount.textContent = needle ? `${visible.length}/${sessions.length}` : (sessions.length ? String(sessions.length) : '');
  if (activeRenameInput && renamingSessionId === activeRenameInput.dataset.sessionId) {
    renameDraft = activeRenameInput.value;
    if (visible.some(session => session.id === renamingSessionId)) return;
  }
  const focusedId = activeElement?.closest?.('[data-session-id]')?.dataset.sessionId;
  let focusedButton = null;
  let renameInputToFocus = null;
  rebuildingSessionList = true;
  try { ui.sessions.replaceChildren(); }
  finally { rebuildingSessionList = false; }
  if (!sessions.length) {
    const message = !workspace ? '选择并信任工作区后查看会话。' : state && state.profile ? '暂无会话，点击“新建会话”开始。' : '选择模型配置后查看会话。';
    ui.sessions.append(element('p', 'sidebar-empty', message));
    return;
  }
  if (!visible.length) {
    ui.sessions.append(element('p', 'sidebar-empty', `没有标题包含“${sessionFilter}”的会话`));
    return;
  }
  for (const session of visible) {
    const item = element('div', 'session-item');
    item.dataset.testid = 'session-item';
    const renaming = renamingSessionId === session.id;
    if (renaming) {
      const input = element('input', 'session-rename-input');
      input.type = 'text';
      input.dataset.sessionId = session.id;
      input.value = renameDraft;
      input.setAttribute('aria-label', '新会话标题');
      const commit = async () => {
        if (renamingSessionId !== session.id) return;
        const title = input.value.trim();
        renamingSessionId = null;
        renameDraft = '';
        if (title && title !== (session.title || '')) {
          try { await window.bitori.renameSession(session.id, title); await refreshSessions(); }
          catch (error) { setActionError(error); }
        }
        renderSessions();
      };
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void commit(); }
        else if (event.key === 'Escape') { renamingSessionId = null; renameDraft = ''; renderSessions(); }
      });
      input.addEventListener('input', () => {
        if (renamingSessionId === session.id) {
          renameDraft = input.value;
        }
      });
      input.addEventListener('blur', () => {
        if (!rebuildingSessionList && input.isConnected && renamingSessionId === session.id) void commit();
      });
      item.append(input);
      renameInputToFocus = input;
    } else {
      const button = element('button', 'session');
      button.type = 'button';
      button.dataset.sessionId = session.id;
      if (focusedId === session.id) focusedButton = button;
      button.disabled = !canUseSession();
      if (state && state.session && state.session.id === session.id) button.setAttribute('aria-current', 'page');
      button.append(element('span', 'session-title', session.title || '新会话'));
      const time = dateText(session.updatedAt || session.createdAt);
      if (time) button.append(element('span', 'session-date', time));
      button.addEventListener('click', () => switchSession(session.id));
      item.append(button);
      const actions = element('div', 'session-actions');
      const rename = element('button', 'session-action', '✎');
      rename.type = 'button';
      rename.title = '重命名会话';
      rename.setAttribute('aria-label', '重命名会话');
      rename.disabled = !canUseSession();
      rename.addEventListener('click', () => { deleteArmedSessionId = null; renamingSessionId = session.id; renameDraft = session.title || ''; renderSessions(); });
      const remove = element('button', 'session-action danger', deleteArmedSessionId === session.id ? '确认?' : '🗑');
      remove.type = 'button';
      remove.title = '删除会话及其全部消息';
      remove.setAttribute('aria-label', '删除会话');
      remove.disabled = !canUseSession();
      remove.addEventListener('click', async () => {
        if (deleteArmedSessionId !== session.id) { deleteArmedSessionId = session.id; renderSessions(); return; }
        deleteArmedSessionId = null;
        try { await window.bitori.deleteSession(session.id); await refreshSessions(); }
        catch (error) { setActionError(error); }
      });
      actions.append(rename, remove);
      item.append(actions);
    }
    ui.sessions.append(item);
  }
  if (renameInputToFocus) {
    const input = renameInputToFocus;
    const sessionId = input.dataset.sessionId;
    window.setTimeout(() => {
      if (renamingSessionId === sessionId && input.isConnected) { input.focus(); input.select(); }
    }, 0);
  }
  if (focusedButton && !focusedButton.disabled) focusedButton.focus({preventScroll: true});
}
function details(label, content, key, className = 'thinking') {
  const node = element('details', className);
  node.dataset.detailKey = key;
  node.open = expanded.has(key);
  node.addEventListener('toggle', () => node.open ? expanded.add(key) : expanded.delete(key));
  node.append(element('summary', '', label));
  node.append(element('pre', className === 'thinking' ? 'thinking-content' : 'tool-content', content));
  return node;
}

function renderTool(call) {
  const status = call.executionStatus || 'queued';
  const key = 'tool:' + call.id;
  const node = element('details', 'tool');
  node.dataset.detailKey = key;
  const edit = call.toolName === 'edit_file' || call.toolName === 'write_file' ? editInfo(call) : null;
  const diff = edit === null ? null : renderDiffNode(edit);
  node.open = collapsed.has(key) ? false : (status === 'running' || status === 'queued' || status === 'failed' || diff !== null || expanded.has(key));
  const summary = element('summary');
  summary.append(element('span', 'tool-icon', toolIcon(call.toolName)));
  summary.append(element('span', 'tool-name', toolDisplay(call.toolName)));
  const argument = primaryArgument(call);
  if (argument) summary.append(element('code', 'tool-arg', argument));
  if (diff !== null) summary.append(element('span', 'tool-diff-count', `+${diff.added} −${diff.removed}`));
  const statusLabel = toolStatusLabels[status] || status;
  summary.append(element('span', 'tool-status ' + status, statusLabel));
  summary.append(element('span', 'tool-chevron', '›'));
  node.append(summary);

  const body = element('div', 'tool-body');
  const meta = element('div', 'tool-meta');
  meta.append(element('span', '', `执行：${statusLabel}`));
  const approval = approvalStatusLabels[call.approvalStatus] || call.approvalStatus;
  if (approval) meta.append(element('span', '', `审批：${approval}`));
  const duration = durationLabel(call);
  if (duration) meta.append(element('span', '', `耗时：${duration}`));
  body.append(meta);

  if (diff !== null) {
    body.append(element('div', 'tool-section-label', '变更'));
    body.append(diff.node);
    if (status === 'succeeded') body.append(renderUndoButton(edit.path));
  } else {
    const args = call.argumentsText || stringify(call.arguments || {});
    body.append(element('div', 'tool-section-label', '参数'));
    body.append(element('pre', '', args || '{}'));
  }
  const result = toolResultText(call);
  if (result) {
    body.append(element('div', 'tool-section-label', '结果'));
    body.append(element('pre', '', result));
  }
  node.append(body);
  node.addEventListener('toggle', () => {
    if (node.open) { expanded.add(key); collapsed.delete(key); }
    else { collapsed.add(key); expanded.delete(key); }
  });
  return node;
}
function renderUndoButton(path) {
  const row = element('div', 'tool-undo-row');
  const button = element('button', 'button small', '撤销此修改');
  button.type = 'button';
  const feedback = element('span', 'undo-feedback', '');
  button.addEventListener('click', async () => {
    if (!path) { feedback.textContent = '快照缺少路径，无法撤销'; return; }
    button.disabled = true;
    feedback.classList.remove('ok');
    feedback.textContent = '撤销中…';
    try {
      const result = await window.bitori.undoEdit(path);
      const message = result && result.message ? result.message : '撤销完成';
      feedback.textContent = message;
      feedback.classList.toggle('ok', !!(result && result.ok));
    } catch (error) {
      feedback.textContent = error && error.message ? error.message : String(error);
    } finally { button.disabled = false; }
  });
  row.append(button, feedback);
  return row;
}
function renderLiveTool(tool) {
  const node = element('div', 'tool live');
  const summary = element('div', 'tool-summary');
  summary.append(element('span', 'live-dot'));
  summary.append(element('span', 'tool-name', toolDisplay(tool.name)));
  summary.append(element('code', 'tool-arg', liveArgument(tool)));
  summary.append(element('span', 'tool-status running', '运行中'));
  node.append(summary);
  if (tool.argumentsText) {
    const body = element('div', 'tool-body');
    body.append(element('div', 'tool-section-label', '参数'));
    body.append(element('pre', '', tool.argumentsText));
    node.append(body);
  }
  return node;
}
function emptyAction(label, operation) {
  const button = element('button', 'empty-action', label);
  button.type = 'button';
  button.addEventListener('click', operation);
  return button;
}
function renderEmptyState() {
  const empty = element('div', 'empty');
  empty.append(element('div', 'empty-mark', '✦'));
  if (!ready) {
    empty.append(element('h2', '', '正在连接'));
    empty.append(element('p', '', '正在读取本地配置…'));
    return empty;
  }
  if (!workspace) {
    empty.append(element('h2', '', '先选择并信任工作区'));
    empty.append(element('p', '', 'Bitori 只会在你确认的工作区内读取文件、执行命令。'));
    empty.append(emptyAction('选择工作区', chooseWorkspace));
    return empty;
  }
  if (!state || !state.profile) {
    empty.append(element('h2', '', '选择模型配置'));
    empty.append(element('p', '', '从左侧选择配置，或点击下方模型名。'));
    empty.append(emptyAction('打开模型选择', openModelMenu));
    return empty;
  }
  empty.append(element('h2', '', '今天想让 Bitori 做什么？'));
  empty.append(element('p', '', '描述任务、粘贴报错，或输入 / 查看命令。'));
  const pill = element('div', 'empty-pill');
  pill.append(element('span', 'kbd', '/'));
  pill.append(element('span', '', '输入斜杠查看命令'));
  pill.append(element('span', 'kbd', 'Ctrl +/-'));
  pill.append(element('span', '', '缩放'));
  empty.append(pill);
  return empty;
}
function renderMessages() {
  const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 100;
  const previousTop = ui.messages.scrollTop;
  const focusedKey = document.activeElement?.closest?.('details[data-detail-key]')?.dataset.detailKey;
  ui.messageList.replaceChildren();
  const messages = state && Array.isArray(state.messages) ? state.messages : [];
  const calls = state && Array.isArray(state.toolCalls) ? state.toolCalls : [];
  const liveTools = state && Array.isArray(state.liveToolCalls) ? state.liveToolCalls : [];
  if (!messages.length && !calls.length && !liveTools.length) ui.messageList.append(renderEmptyState());
  const usedCalls = new Set();
  const usedLive = new Set();
  for (const message of messages) {
    if (message.role === 'user') {
      const article = element('article', 'message user');
      const bubble = element('div', 'user-bubble');
      const content = message.displayContent ?? message.content;
      if (content) bubble.append(element('div', 'message-body', content));
      const attachments = renderMessageAttachments(message.attachments);
      if (attachments) bubble.append(attachments);
      article.append(bubble);
      if (message.errorMessage) article.append(element('div', 'message-error', message.errorMessage));
      ui.messageList.append(article);
      continue;
    }
    const article = element('article', 'message assistant');
    const heading = element('div', 'message-heading');
    heading.append(element('span', 'brand-dot', '●'));
    heading.append(element('span', '', 'Bitori'));
    const messageStatus = {streaming: '生成中', cancelled: '已停止', failed: '失败'}[message.status];
    if (messageStatus) heading.append(element('span', 'message-meta', messageStatus));
    article.append(heading);
    if (message.thinking) article.append(details('思考过程', message.thinking, 'thinking:' + message.id));
    const content = message.displayContent ?? message.content;
    if (content) {
      if (message.status !== 'streaming' && window.BitoriMarkdown) {
        const body = element('div', 'message-body markdown');
        body.append(window.BitoriMarkdown.render(content));
        article.append(body);
      } else {
        article.append(element('div', 'message-body', content));
      }
    } else if (message.status === 'streaming' && !message.thinking) article.append(element('div', 'typing', '正在思考…'));
    if (message.errorMessage) article.append(element('div', 'message-error', message.errorMessage));
    for (const call of calls) {
      if (call.assistantMessageId === message.id) {
        article.append(renderTool(call));
        usedCalls.add(call.id);
      }
    }
    for (const tool of liveTools) {
      if (tool.iterationId === message.id) {
        article.append(renderLiveTool(tool));
        usedLive.add(tool.callId);
      }
    }
    ui.messageList.append(article);
  }
  for (const call of calls) if (!usedCalls.has(call.id)) ui.messageList.append(renderTool(call));
  for (const tool of liveTools) if (!usedLive.has(tool.callId)) ui.messageList.append(renderLiveTool(tool));
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
  ui.approvalDetail.replaceChildren();
  const edit = prompt.toolName === 'edit_file' || prompt.toolName === 'write_file'
    ? editInfo({toolName: prompt.toolName, arguments: parseArgumentSummary(prompt.argumentSummary)})
    : null;
  if (edit !== null) {
    ui.approvalDetail.append(element('div', 'tool-section-label', edit.path || '目标文件'));
    ui.approvalDetail.append(renderDiffNode(edit, 24).node);
  } else {
    ui.approvalDetail.append(element('pre', '', prompt.argumentSummary || '无参数'));
  }
  const risk = [prompt.riskMessage, prompt.reason].filter(Boolean).join('\n');
  ui.approvalRisk.textContent = risk;
  ui.approvalRisk.hidden = !risk;
}
function renderRecovery() {
  const recovery = state && state.recovery;
  ui.recovery.hidden = !recovery;
  if (!recovery) return;
  ui.recoveryMessage.textContent = recovery.message || '发现可恢复的中断任务。';
  ui.recoveryNote.textContent = recovery.requiresConfirmation
    ? '请先检查中断前写入或命令的实际结果，再确认继续。桌面界面不会直接重放旧工具调用。'
    : '继续将调用控制器的恢复流程；桌面界面不会直接重放旧工具调用。';
  ui.recoveryContinue.textContent = recovery.requiresConfirmation ? '我已检查，继续恢复' : '继续恢复';
  ui.recoveryContinue.disabled = recoveryPending || changingContext || isActive();
}
function parseArgumentSummary(text) {
  try {
    const value = JSON.parse(String(text || ''));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}
function renderControls() {
  const canWorkspace = canChangeWorkspace();
  const canProfile = canChangeContext();
  const canSession = canUseSession();
  const active = isActive();
  ui.chooseWorkspace.disabled = !canWorkspace;
  ui.profile.disabled = !canProfile || !profiles.length;
  ui.newSession.disabled = !canSession;
  ui.importSession.disabled = !canSession || actionPending;
  ui.exportSession.disabled = !canSession || actionPending || !(state && state.session);
  ui.chooseImages.disabled = !canSession || attachmentActionPending;
  ui.pasteImage.disabled = !canSession || attachmentActionPending;
  for (const remove of ui.attachmentDrafts.querySelectorAll('[data-remove-attachment]')) remove.disabled = !canSession || attachmentActionPending;
  ui.input.disabled = !ready || changingContext;
  ui.send.disabled = ui.input.disabled || !workspace || !(state && state.profile) || !(state && state.session) || Boolean(state && state.recovery) || active || sending || actionPending || (!ui.input.value.trim() && draftAttachments.length === 0);
  ui.composerPlus.disabled = !canSession;
  ui.cancel.hidden = !active;
  ui.cancel.disabled = state && state.requestStatus === 'cancelling';
  ui.deny.disabled = ui.allowOnce.disabled = ui.allowSession.disabled = ui.allowAlways.disabled = approvalPending || changingContext;
  ui.input.placeholder = !ready ? '正在连接…' : !workspace ? '请先选择并信任工作区' : !(state && state.profile) ? '请选择模型配置' : '描述任务，或向 Bitori 提问';
  ui.composerHelp.textContent = !ready ? '正在读取本地配置…' : !workspace ? '先在左侧选择并信任工作区' : !(state && state.profile) ? '先在左侧选择模型配置' : state && state.recovery ? '请先确认中断任务的恢复操作' : 'Enter 发送 · Shift + Enter 换行 · / 命令 · Ctrl +/- 缩放';
  ui.profile.title = !workspace ? '请先选择并信任工作区' : !profiles.length ? '没有可用模型配置；运行 bitori doctor 检查配置，或编辑 ~/.bitori/config.yaml 添加 profile' : canProfile ? '' : contextBlockReason();
  ui.newSession.title = canSession ? '' : contextBlockReason();
  ui.send.title = ui.send.disabled ? (contextBlockReason() || '输入消息后发送') : '发送';
  ui.composerPlus.title = canSession ? '打开命令' : contextBlockReason();
  ui.modelButton.classList.toggle('disabled', !canProfile);
  ui.modelButton.setAttribute('aria-disabled', String(!canProfile));
  ui.modelButton.tabIndex = canProfile ? 0 : -1;
  ui.modelButton.title = canProfile ? '切换模型配置' : contextBlockReason();
  ui.status.textContent = changingContext ? '正在加载' : !ready ? '正在连接' : state ? (statusLabels[state.requestStatus] || state.requestStatus || '就绪') : workspace ? '等待配置' : '等待工作区';
  ui.status.dataset.state = !state || !ready ? 'none' : active ? 'busy' : state.requestStatus === 'failed' ? 'failed' : 'idle';
  renderSessions();
}
function render() {
  syncAttachmentScope();
  ui.workspace.textContent = workspace || '未选择工作区';
  ui.workspace.title = workspace || '未选择工作区';
  ui.workspaceName.textContent = baseName(workspace);
  ui.workspaceName.title = workspace || '当前工作区';
  ui.title.textContent = state && state.session && state.session.title || '新会话';
  const profile = state && state.profile;
  ui.profileDetail.textContent = profile ? [profile.name, profile.protocol, profile.model].filter(Boolean).join(' · ') : workspace ? '请选择配置' : '请先选择工作区';
  ui.modelName.textContent = profile ? profile.model : '未选择模型';
  ui.composerProfile.textContent = profile ? profile.name : '未选择配置';
  ui.composerMode.textContent = profile ? (state.agentMode === 'plan' ? 'PLAN' : 'DO') : '—';
  ui.composerPermission.textContent = profile ? permissionLabel(state.permissionTier) : '—';
  const usage = state && state.runUsage;
  ui.usageValue.textContent = profile ? formatUsage(usage) : '—';
  renderProfiles();
  renderMessages();
  renderApproval();
  renderRecovery();
  showError();
  renderControls();
}

function allCommands() {
  const map = new Map();
  for (const command of [...UI_COMMANDS, ...commandCatalog]) {
    if (!map.has(command.name)) map.set(command.name, command);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function closeSlash() {
  slashOpen = false;
  slashIndex = 0;
  ui.slashMenu.hidden = true;
  ui.slashMenu.replaceChildren();
}
function renderSlashMenu() {
  if (!slashOpen) { ui.slashMenu.hidden = true; return; }
  ui.slashMenu.hidden = false;
  ui.slashMenu.replaceChildren();
  const heading = element('div', 'menu-heading');
  heading.append(element('span', '', '命令'));
  const keys = element('span', '');
  keys.append(element('kbd', '', '↑↓ 选择 · Tab 补全 · Enter 运行 · Esc 关闭'));
  heading.append(keys);
  ui.slashMenu.append(heading);
  if (!slashItems.length) {
    ui.slashMenu.append(element('div', 'menu-empty', '没有匹配的命令'));
    return;
  }
  slashItems.forEach((command, index) => {
    const row = element('button', 'menu-row' + (index === slashIndex ? ' active' : ''));
    row.type = 'button';
    row.append(element('span', 'menu-command', '/' + command.name));
    if (command.argumentHint) row.append(element('span', 'menu-hint', command.argumentHint));
    row.append(element('span', 'menu-desc', command.description || ''));
    row.addEventListener('click', () => chooseCommand(command));
    ui.slashMenu.append(row);
  });
  const activeRow = ui.slashMenu.querySelector('.menu-row.active');
  activeRow?.scrollIntoView({block: 'nearest'});
}
function updateSlashFromInput() {
  const match = /^\/(\S*)$/.exec(ui.input.value);
  if (!match || !ready || !state || !state.profile || isActive() || changingContext) { closeSlash(); return; }
  const query = match[1].toLowerCase();
  slashOpen = true;
  slashItems = allCommands().filter(command => command.name.toLowerCase().startsWith(query) || (command.aliases || []).some(alias => alias.toLowerCase().startsWith(query)));
  slashIndex = Math.max(0, Math.min(slashIndex, slashItems.length - 1));
  renderSlashMenu();
}
function executeSlash(text) {
  closeSlash();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return;
  const name = match[1].toLowerCase();
  const args = (match[2] || '').trim();
  if (runLocalCommand(name, args)) return;
  sendText(text);
}
function runLocalCommand(name, args) {
  const aliases = new Map([['exit', 'quit'], ['q', 'quit']]);
  const command = UI_COMMANDS.find(item => item.name === name || (item.aliases || []).includes(name)) || UI_COMMANDS.find(item => item.name === aliases.get(name));
  if (!command) return false;
  if (command.name === 'model') {
    if (args) {
      const profile = profiles.find(item => item.name === args) || profiles.find(item => item.model === args);
      if (!profile) setActionError(`未知模型配置：${args}`);
      else if (profile.name !== (state && state.profile && state.profile.name)) {
        if (!canChangeContext()) setActionError(contextBlockReason());
        else changeContext(() => window.bitori.selectProfile(profile.name));
      }
    } else openModelMenu();
    return true;
  }
  if (command.name === 'new') { newSession(); return true; }
  if (command.name === 'sessions') {
    const first = ui.sessions.querySelector('[data-session-id]');
    if (first) { first.focus(); first.scrollIntoView({block: 'nearest'}); }
    else setActionError('暂无会话');
    return true;
  }
  if (command.name === 'help') { openCommandMenu(); return true; }
  if (command.name === 'clear') { ui.input.value = ''; resizeInput(); updateSlashFromInput(); renderControls(); return true; }
  return false;
}
function clearComposer() {
  ui.input.value = '';
  resizeInput();
  closeSlash();
  renderControls();
}
function chooseCommand(command) {
  if (command.name === 'model') { clearComposer(); openModelMenu(); return; }
  if (command.name === 'new') { clearComposer(); newSession(); return; }
  if (command.name === 'sessions') { clearComposer(); runLocalCommand('sessions', ''); return; }
  if (command.name === 'help') { openCommandMenu(); return; }
  if (command.name === 'clear') { closeSlash(); ui.input.value = ''; resizeInput(); renderControls(); ui.input.focus(); return; }
  if (command.argumentHint) {
    closeSlash();
    ui.input.value = `/${command.name} `;
    ui.input.focus();
    renderControls();
    return;
  }
  closeSlash();
  ui.input.value = `/${command.name}`;
  executeSlash(ui.input.value);
}
function openCommandMenu() {
  if (!canUseSession()) { setActionError(contextBlockReason()); return; }
  closeModelMenu();
  ui.input.value = '/';
  resizeInput();
  ui.input.focus();
  slashIndex = 0;
  updateSlashFromInput();
  renderControls();
}
function openModelMenu() {
  if (!profiles.length) { setActionError('没有可用模型配置；运行 bitori doctor 检查配置，或编辑 ~/.bitori/config.yaml 添加 profile'); return; }
  if (!canChangeContext()) { setActionError(contextBlockReason()); return; }
  modelMenuOpen = true;
  ui.modelMenu.hidden = false;
  renderModelMenu();
}
function renderModelMenu() {
  ui.modelMenu.replaceChildren();
  const heading = element('div', 'menu-heading');
  heading.append(element('span', '', '选择模型配置'));
  heading.append(element('kbd', '', 'Esc 关闭'));
  ui.modelMenu.append(heading);
  for (const profile of profiles) {
    const current = state && state.profile && state.profile.name === profile.name;
    const row = element('button', 'menu-row model-row');
    row.type = 'button';
    row.append(element('span', 'menu-command', profile.name));
    row.append(element('span', 'menu-hint', profile.model));
    row.append(element('span', 'menu-desc', profile.protocol));
    if (current) row.append(element('span', 'model-current', '当前'));
    row.addEventListener('click', () => {
      closeModelMenu();
      if (current) return;
      if (!canChangeContext()) { setActionError(contextBlockReason()); return; }
      changeContext(() => window.bitori.selectProfile(profile.name));
    });
    ui.modelMenu.append(row);
    ui.modelMenu.append(renderModelListing(profile, current));
  }
}
/** profile 内模型列表 + 连接测试；Provider 不能列模型时显示原因,不伪造。 */
function renderModelListing(profile, current) {
  const line = element('div', 'menu-row model-listing');
  const toggle = element('button', 'button small', modelState && modelState.name === profile.name ? '收起' : '模型/连接测试');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    if (modelState && modelState.name === profile.name) modelState = null;
    else {
      modelState = {name: profile.name, loading: true, models: [], error: '', note: ''};
      window.bitori.listModels(profile.name).then(result => {
        if (!modelState || modelState.name !== profile.name) return;
        modelState = {name: profile.name, loading: false, models: result.models || [], error: result.error || '', note: result.note || ''};
        if (modelMenuOpen) renderModelMenu();
      }).catch(error => {
        if (!modelState || modelState.name !== profile.name) return;
        modelState = {name: profile.name, loading: false, models: [], error: String(error && error.message ? error.message : error), note: ''};
        if (modelMenuOpen) renderModelMenu();
      });
    }
    if (modelMenuOpen) renderModelMenu();
  });
  line.append(toggle);
  if (modelState && modelState.name === profile.name) {
    if (modelState.loading) line.append(element('span', 'menu-desc', '正在向 Provider 查询…'));
    else {
      if (modelState.error) line.append(element('span', 'menu-desc model-error', modelState.error));
      if (modelState.note) line.append(element('span', 'menu-desc', modelState.note));
      for (const model of modelState.models) {
        const chip = element('button', 'button small model-chip', model.displayName && model.displayName !== model.id ? `${model.id} · ${model.displayName}` : model.id);
        chip.type = 'button';
        chip.disabled = model.enabled === false || changingContext;
        chip.addEventListener('click', () => {
          if (!canChangeContext()) { setActionError(contextBlockReason()); return; }
          closeModelMenu();
          changeContext(() => window.bitori.selectProfile(profile.name, model.id));
        });
        line.append(chip);
      }
      if (modelState.models.length && !modelState.error) {
        const useDefault = element('button', 'button small', `使用配置默认(${profile.model})`);
        useDefault.type = 'button';
        useDefault.disabled = changingContext;
        useDefault.addEventListener('click', () => {
          if (!canChangeContext()) { setActionError(contextBlockReason()); return; }
          closeModelMenu();
          if (!current || state.profile.model !== profile.model) changeContext(() => window.bitori.selectProfile(profile.name));
        });
        line.append(useDefault);
      }
    }
  }
  return line;
}
function closeModelMenu() {
  modelState = null;
  modelMenuOpen = false;
  ui.modelMenu.hidden = true;
  ui.modelMenu.replaceChildren();
}
async function refreshCommands() {
  if (!window.bitori.commands || !state || !state.profile) { commandCatalog = []; return; }
  try {
    const list = await window.bitori.commands();
    commandCatalog = Array.isArray(list) ? list : [];
  } catch { commandCatalog = []; }
  if (slashOpen) updateSlashFromInput();
}
function resizeInput() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(180, Math.max(30, ui.input.scrollHeight))}px`;
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
  closeSlash();
  closeModelMenu();
  render();
  void refreshCommands();
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
  if (!canChangeWorkspace()) return;
  changingContext = true;
  clearActionError();
  closeSlash();
  closeModelMenu();
  renderControls();
  try {
    const snapshot = await operation();
    if (snapshot) applySnapshot(snapshot);
  } catch (error) { setActionError(error); }
  finally { changingContext = false; render(); }
}
async function sessionAction(operation) {
  if (!canUseSession()) { setActionError(contextBlockReason() || '请先停止当前任务'); return; }
  actionPending = true;
  clearActionError();
  renderControls();
  try { await operation(); await refreshSessions(); }
  catch (error) { setActionError(error); }
  finally { actionPending = false; renderControls(); }
}
async function exportCurrentSession() {
  if (!canUseSession() || actionPending || !state?.session) { setActionError(contextBlockReason()); return; }
  actionPending = true;
  clearActionError();
  setSessionFeedback('');
  renderControls();
  try {
    const result = await window.bitori.exportSession();
    if (result) {
      await refreshSessions();
      setSessionFeedback(`会话已导出：${result.fileName || '归档文件'}`, 'success');
    }
  } catch (error) { setActionError(error); }
  finally { actionPending = false; renderControls(); }
}
async function importSessionArchive() {
  if (!canUseSession() || actionPending) { setActionError(contextBlockReason()); return; }
  actionPending = true;
  clearActionError();
  setSessionFeedback('');
  renderControls();
  try {
    const result = await window.bitori.importSession();
    if (result) {
      if (result.snapshot) applySnapshot(result.snapshot);
      else await refreshSessions();
      setSessionFeedback(`会话已导入：${result.fileName || '归档文件'}`, 'success');
    }
  } catch (error) { setActionError(error); }
  finally { actionPending = false; render(); }
}
async function resumeRecovery() {
  if (!state || !state.recovery || recoveryPending || isActive()) return;
  recoveryPending = true;
  clearActionError();
  renderRecovery();
  try { await window.bitori.resumeInterruptedRun(); }
  catch (error) { setActionError(error); }
  finally { recoveryPending = false; renderRecovery(); }
}
function newSession() { sessionAction(() => window.bitori.newSession()); }
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
async function sendText(text) {
  const attachments = [...draftAttachments];
  if ((!text && attachments.length === 0) || !ready || !workspace || !state || !state.profile || !state.session || state.recovery || isActive() || sending) return;
  const previousVersion = stateVersion;
  const previousMessageIds = new Set(state.messages.map(message => message.id));
  sending = true;
  clearActionError();
  ui.input.value = '';
  resizeInput();
  closeSlash();
  renderControls();
  try {
    await window.bitori.send(text, attachments);
    const hasNewUserMessage = state && Array.isArray(state.messages) && state.messages.some(message => message.role === 'user' && !previousMessageIds.has(message.id));
    if (stateVersion !== previousVersion && state && state.visibleError && (state.requestStatus === 'failed' || !hasNewUserMessage)) {
      throw new Error(state.visibleError);
    }
    if (stateVersion !== previousVersion && state && state.requestStatus === 'failed') throw new Error(state.visibleError || '请求失败');
    if (attachments.length > 0) {
      const sent = new Set(attachments);
      draftAttachments = draftAttachments.filter(image => !sent.has(image));
      renderDraftAttachments();
    }
  }
  catch (error) {
    if (text && !ui.input.value) { ui.input.value = text; resizeInput(); }
    setActionError(error);
  } finally {
    sending = false;
    renderControls();
    scheduleSessionRefresh();
  }
}

ui.profile.addEventListener('change', () => {
  const name = ui.profile.value;
  if (!name || (state && state.profile && state.profile.name === name)) return;
  if (!canChangeContext()) { setActionError(contextBlockReason()); renderProfiles(); return; }
  changeContext(() => window.bitori.selectProfile(name));
});
function chooseWorkspace() { changeContext(() => window.bitori.chooseWorkspace()); }
ui.chooseWorkspace.addEventListener('click', chooseWorkspace);
ui.sessionSearch.addEventListener('input', () => { sessionFilter = ui.sessionSearch.value; renderSessions(); });
document.addEventListener('keydown', event => {
  // 审批面板可见时对齐 TUI 快捷键：Y 本次 / S 本会话 / P 永久 / N·Esc 拒绝。
  if (!state || !state.approvalPrompt || ui.approval.hidden) return;
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'y') { event.preventDefault(); void decide('allow_once'); }
  else if (key === 's') { event.preventDefault(); void decide('allow_session'); }
  else if (key === 'p') { event.preventDefault(); void decide('allow_always'); }
  else if (key === 'n' || key === 'escape') { event.preventDefault(); void decide('deny'); }
});
ui.newSession.addEventListener('click', newSession);
ui.importSession.addEventListener('click', importSessionArchive);
ui.exportSession.addEventListener('click', exportCurrentSession);
ui.chooseImages.addEventListener('click', chooseImages);
ui.pasteImage.addEventListener('click', pasteImage);
ui.recoveryContinue.addEventListener('click', resumeRecovery);
ui.allowOnce.addEventListener('click', () => decide('allow_once'));
ui.allowSession.addEventListener('click', () => decide('allow_session'));
ui.allowAlways.addEventListener('click', () => decide('allow_always'));
ui.deny.addEventListener('click', () => decide('deny'));
ui.cancel.addEventListener('click', async () => {
  clearActionError();
  ui.cancel.disabled = true;
  try { await window.bitori.cancel(); }
  catch (error) { setActionError(error); }
  finally { renderControls(); }
});
ui.modelButton.addEventListener('click', openModelMenu);
ui.modelButton.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openModelMenu(); }
});
ui.composerPlus.addEventListener('click', openCommandMenu);
ui.messageList.addEventListener('click', event => {
  const link = event.target?.closest?.('a[data-external-url]');
  if (!link) return;
  event.preventDefault();
  const url = link.dataset.externalUrl;
  if (!url || !window.bitori.openExternal) return;
  window.bitori.openExternal(url).catch(error => setActionError(error));
});
ui.input.addEventListener('input', () => {
  resizeInput();
  updateSlashFromInput();
  renderControls();
});
ui.input.addEventListener('paste', event => {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return;
  const imageItems = Array.from(clipboardData.items).some(item => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    || Array.from(clipboardData.files).some(file => file.type.toLowerCase().startsWith('image/'));
  if (!imageItems) return;
  event.preventDefault();
  void pasteImage();
});
ui.input.addEventListener('focus', updateSlashFromInput);
ui.input.addEventListener('keydown', event => {
  if (modelMenuOpen) {
    if (event.key === 'Escape') { event.preventDefault(); closeModelMenu(); return; }
  }
  if (slashOpen) {
    if (event.key === 'ArrowDown') { event.preventDefault(); slashIndex = Math.min(slashItems.length - 1, slashIndex + 1); renderSlashMenu(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); slashIndex = Math.max(0, slashIndex - 1); renderSlashMenu(); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const command = slashItems[slashIndex];
      if (command) { ui.input.value = `/${command.name}${command.argumentHint ? ' ' : ''}`; resizeInput(); closeSlash(); renderControls(); }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const command = slashItems[slashIndex];
      if (command) chooseCommand(command);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeSlash(); return; }
  }
  if (event.key === 'Escape') { closeModelMenu(); }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if (!ui.send.disabled) ui.composer.requestSubmit();
  }
});
ui.composer.addEventListener('submit', async event => {
  event.preventDefault();
  const text = ui.input.value.trim();
  if ((!text && draftAttachments.length === 0) || ui.send.disabled) return;
  if (text.startsWith('/')) {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (match && runLocalCommand(match[1].toLowerCase(), (match[2] || '').trim())) {
      if (ui.input.value.trim() === text) clearComposer();
      return;
    }
  }
  await sendText(text);
});
function showZoom(factor) {
  currentZoom = factor;
  ui.zoomBadge.hidden = false;
  ui.zoomBadge.textContent = `缩放 ${Math.round(factor * 100)}%`;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => { ui.zoomBadge.hidden = true; }, 1600);
}
function applyZoom(next) {
  if (window.bitori && window.bitori.setZoom) {
    window.bitori.setZoom(next).then(showZoom).catch(() => {});
  }
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeSlash(); closeModelMenu(); }
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key === '=' || event.key === '+') { event.preventDefault(); applyZoom(currentZoom + 0.1); return; }
    if (event.key === '-') { event.preventDefault(); applyZoom(currentZoom - 0.1); return; }
    if (event.key === '0') { event.preventDefault(); applyZoom(1); }
  }
});

async function start() {
  if (!window.bitori) {
    configError = '无法连接桌面服务，请重新启动应用。';
    showError();
    return;
  }
  if (window.bitori.onZoom) window.bitori.onZoom(showZoom);
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
    await refreshCommands();
    scheduleSessionRefresh();
  } catch (error) { configError = messageForError(error); showError(); }
}
renderControls();
start();
