import {Box, Text, useInput, usePaste, useWindowSize} from 'ink';
import {useMemo, useRef, useState} from 'react';
import {imageAttachmentsSchema, loadImageAttachment} from '../../attachments/images.js';
import type {ImageAttachment} from '../../attachments/images.js';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';
import type {ProfileSummary} from '../../config/types.js';
import type {RemoteModel} from '../../diagnostics/connection.js';
import {readSessionArchive, writeSessionArchive} from '../../storage/archive.js';
import type {Session} from '../../storage/types.js';
import type {ApprovalDecision} from '../../tools/types.js';
import {Activity} from '../components/activity.js';
import {DebugPanel} from '../components/debug-panel.js';
import {DiffPanel} from '../components/diff-panel.js';
import {ErrorBanner} from '../components/error-banner.js';
import {Header} from '../components/header.js';
import {MessageList} from '../components/message-list.js';
import {ModelPicker} from '../components/model-picker.js';
import {PromptInput} from '../components/prompt-input.js';
import {QueuedMessages} from '../components/queued-messages.js';
import {SessionList} from '../components/session-list.js';
import {SlashMenu, type PaletteCommand} from '../components/slash-menu.js';
import {StatusBar} from '../components/status-bar.js';
import {ToolApprovalPanel} from '../components/tool-approval-panel.js';
import {useSpinner} from '../hooks/use-spinner.js';
import {theme, type Density} from '../theme.js';
import {wrapFlow} from '../cursor-position.js';

export interface ChatScreenProps {
  state: AppState;
  controller: ChatController;
  height: number;
  onExit: () => void;
  profiles?: ProfileSummary[];
  onSwitchProfile?: (profileName: string, modelOverride?: string) => Promise<void>;
  listModels?: (profileName: string) => Promise<{models: RemoteModel[]; note?: string; error?: string}>;
  workspace?: string | undefined;
}

function filterSessions(sessions: Session[], filter: string): Session[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return sessions;
  return sessions.filter(session => (session.title || '新会话').toLowerCase().includes(needle));
}

const UI_COMMANDS: PaletteCommand[] = [
  {name: 'attach', description: '附加图片文件', argumentHint: '<path>'},
  {name: 'attachments', description: '清除待发送图片', argumentHint: 'clear'},
  {name: 'export', description: '导出当前会话', argumentHint: '<path>'},
  {name: 'import', description: '导入会话归档', argumentHint: '<path>'},
  {name: 'model', description: '切换模型配置', argumentHint: '<name>'},
  {name: 'new', description: '新建会话'},
  {name: 'resume', description: '确认继续中断的回合'},
  {name: 'sessions', description: '打开历史会话'},
  {name: 'diff', description: '查看本次会话的代码改动'},
  {name: 'help', description: '浏览全部命令'},
  {name: 'quit', description: '退出 Bitori', aliases: ['exit', 'q']},
];

const approvalDecisions: readonly ApprovalDecision[] = ['approved', 'approved_session', 'approved_permanent', 'denied'];

interface LocalCommand {name: string; args: string}
interface SessionDraft {text: string; attachments: ImageAttachment[]}

function emptySessionDraft(): SessionDraft { return {text: '', attachments: []}; }

function parsePathArgument(argument: string): string {
  const value = argument.trim();
  if (value === '') throw new Error('请提供文件路径');
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  if (value.length < 2 || value.at(-1) !== quote) throw new Error('路径引号不匹配');
  const path = value.slice(1, -1).replaceAll(`\\${quote}`, quote);
  if (path.trim() === '') throw new Error('请提供文件路径');
  return path;
}

/** 聊天页负责把键盘/粘贴事件翻译成 controller 操作，并组合各展示组件。 */
export function ChatScreen({state, controller, height, onExit, profiles = [], onSwitchProfile, listModels, workspace}: ChatScreenProps) {
  const {columns} = useWindowSize();
  const [draftsBySession, setDraftsBySession] = useState<Map<string | null, SessionDraft>>(() => new Map());
  const activeSessionId = state.session?.id ?? null;
  const currentDraft = draftsBySession.get(activeSessionId) ?? emptySessionDraft();
  const draft = currentDraft.text;
  const [focus, setFocus] = useState<'input' | 'messages'>('input');
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [sessionFilter, setSessionFilter] = useState('');
  const [sessionRenaming, setSessionRenaming] = useState(false);
  const [sessionRenameValue, setSessionRenameValue] = useState('');
  const [sessionDeletePending, setSessionDeletePending] = useState<Session | null>(null);
  const [sessionPending, setSessionPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [density, setDensity] = useState<Density>(1);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteHidden, setPaletteHidden] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelIndex, setModelIndex] = useState(0);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelStage, setModelStage] = useState<'profiles' | 'models'>('profiles');
  const [modelList, setModelList] = useState<{name: string; models: RemoteModel[]; loading: boolean; note?: string; error?: string} | null>(null);
  const [modelModelIndex, setModelModelIndex] = useState(0);
  const [approvalSelection, setApprovalSelection] = useState<{callId: string; index: number} | null>(null);
  const sessionPendingRef = useRef(false);
  const sendingRef = useRef(false);
  const switchingRef = useRef(false);
  const attachmentPendingRef = useRef(false);
  // failed 已经是一次请求的终态，不阻止用户继续发送；其余进行中状态才算 busy。
  const busy = state.requestStatus !== 'idle' && state.requestStatus !== 'failed';
  const spinner = useSpinner(busy);
  // 生成期间输入框不锁死：允许随时打字，Enter 走排队而不是被忽略。
  // 审批是模态的：此时输入归审批面板，真实光标也收起来。
  const disabled = sessionPending || switchingModel || attachmentLoading || state.approvalPrompt !== null;
  const catalog = useMemo(() => {
    const merged = new Map<string, PaletteCommand>();
    for (const command of [...UI_COMMANDS, ...(controller.commandCatalog?.() ?? [])]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [controller]);
  const setSessionDraft = (sessionId: string | null, value: SessionDraft) => {
    setDraftsBySession(current => {
      const drafts = new Map(current);
      drafts.set(sessionId, value);
      return drafts;
    });
  };

  const updateSessionDraft = (sessionId: string | null, update: (value: SessionDraft) => SessionDraft) => {
    setDraftsBySession(current => {
      const previous = current.get(sessionId) ?? emptySessionDraft();
      const drafts = new Map(current);
      drafts.set(sessionId, update(previous));
      return drafts;
    });
  };

  const restoreSessionDraft = (sessionId: string | null, snapshot: SessionDraft) => {
    updateSessionDraft(sessionId, current => {
      const attachmentsMatch = current.attachments.length === snapshot.attachments.length && current.attachments.every((attachment, index) => {
        const submitted = snapshot.attachments[index];
        return submitted !== undefined && attachment.name === submitted.name && attachment.mediaType === submitted.mediaType && attachment.data === submitted.data;
      });
      return current.text === '' && (current.attachments.length === 0 || attachmentsMatch)
        ? {text: snapshot.text, attachments: [...snapshot.attachments]}
        : current;
    });
  };

  const updateDraft = (next: string | ((value: string) => string)) => {
    updateSessionDraft(activeSessionId, current => ({
      ...current,
      text: typeof next === 'function' ? next(current.text) : next,
    }));
    setPaletteIndex(0);
    setPaletteHidden(false);
    setOperationNotice(null);
  };

  const runExclusiveOperation = (operation: () => Promise<void>, busyMessage: string, onFailure?: () => void) => {
    if (sessionPendingRef.current || sendingRef.current || busy || switchingRef.current || attachmentPendingRef.current) {
      setOperationError(attachmentPendingRef.current ? '图片仍在读取，暂不能执行此操作' : busyMessage);
      onFailure?.();
      return;
    }
    sessionPendingRef.current = true;
    setSessionPending(true);
    setOperationError(null);
    setOperationNotice(null);
    void Promise.resolve().then(operation).catch((error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error));
      onFailure?.();
    }).finally(() => { sessionPendingRef.current = false; setSessionPending(false); });
  };

  const runSessionOperation = (operation: () => Promise<void>) => runExclusiveOperation(operation, '生成期间不能切换会话');

  const switchModel = (name: string, modelOverride?: string) => {
    if (switchingRef.current) return;
    const profile = profiles.find(item => item.name === name) ?? profiles.find(item => item.model === name);
    if (!profile) { setOperationError(`未知模型配置：${name}`); return; }
    if (profile.name === state.profile?.name && modelOverride === undefined && state.profile?.model === profile.model) { setModelPickerOpen(false); return; }
    if (busy || sessionPendingRef.current || sendingRef.current || attachmentPendingRef.current) { setOperationError('生成期间不能切换模型'); return; }
    if (!onSwitchProfile) { setOperationError('当前环境不支持切换模型'); return; }
    switchingRef.current = true;
    setSwitchingModel(true);
    setOperationError(null);
    void onSwitchProfile(profile.name, modelOverride).catch((error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error));
      switchingRef.current = false;
      setSwitchingModel(false);
    });
  };

  const closeModelPicker = () => {
    setModelPickerOpen(false);
    setModelStage('profiles');
    setModelList(null);
  };

  /** 选定 profile 后进入第二级：向 Provider 查询真实模型列表；查询失败必须说明原因，不伪造列表。 */
  const chooseProfileForModels = (name: string) => {
    if (listModels === undefined || onSwitchProfile === undefined) { switchModel(name); return; }
    if (busy || sessionPendingRef.current || sendingRef.current || attachmentPendingRef.current) { setOperationError('生成期间不能切换模型'); return; }
    setModelStage('models');
    setModelModelIndex(0);
    setModelList({name, models: [], loading: true});
    void listModels(name).then(result => {
      setModelList({name, models: result.models, loading: false, ...(result.note === undefined ? {} : {note: result.note}), ...(result.error === undefined ? {} : {error: result.error})});
    }).catch((error: unknown) => {
      setModelList({name, models: [], loading: false, error: error instanceof Error ? error.message : String(error)});
    });
  };

  const runLocalCommand = (command: LocalCommand, submittedDraft: SessionDraft = currentDraft, sessionId: string | null = activeSessionId): boolean => {
    if (command.name === 'model') {
      if (command.args) switchModel(command.args);
      else {
        const current = profiles.findIndex(profile => profile.name === state.profile?.name);
        setModelIndex(Math.max(0, current));
        setModelStage('profiles');
        setModelList(null);
        setModelPickerOpen(true);
      }
      return true;
    }
    if (command.name === 'help') { updateDraft('/'); return true; }
    if (command.name === 'attach') {
      let path: string;
      try { path = parsePathArgument(command.args); }
      catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
        restoreSessionDraft(sessionId, submittedDraft);
        return true;
      }
      if (attachmentPendingRef.current) {
        setOperationError('图片仍在读取，请稍后再附加');
        restoreSessionDraft(sessionId, submittedDraft);
        return true;
      }
      attachmentPendingRef.current = true;
      setAttachmentLoading(true);
      setOperationError(null);
      setOperationNotice(null);
      void loadImageAttachment(path).then(image => {
        const attachments = imageAttachmentsSchema.parse([...submittedDraft.attachments, image]);
        setSessionDraft(sessionId, {text: '', attachments});
        setOperationNotice(`已附加图片：${image.name}`);
      }).catch((error: unknown) => {
        setOperationError(error instanceof Error ? error.message : String(error));
        restoreSessionDraft(sessionId, submittedDraft);
      }).finally(() => {
        attachmentPendingRef.current = false;
        setAttachmentLoading(false);
      });
      return true;
    }
    if (command.name === 'attachments') {
      if (command.args.toLowerCase() !== 'clear') {
        setOperationError('用法：/attachments clear');
        restoreSessionDraft(sessionId, submittedDraft);
      } else {
        setSessionDraft(sessionId, emptySessionDraft());
        setOperationError(null);
        setOperationNotice('已清除待发送图片');
      }
      return true;
    }
    if (command.name === 'export' || command.name === 'import') {
      let path: string;
      try { path = parsePathArgument(command.args); }
      catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error));
        restoreSessionDraft(sessionId, submittedDraft);
        return true;
      }
      if (command.name === 'export') {
        runExclusiveOperation(async () => {
          const conversation = await controller.exportSession();
          await writeSessionArchive(path, conversation);
          setOperationNotice(`会话已导出：${path}`);
        }, '生成期间不能导出会话', () => restoreSessionDraft(sessionId, submittedDraft));
      } else {
        runExclusiveOperation(async () => {
          const conversation = await readSessionArchive(path);
          await controller.importSession(conversation);
          setOperationNotice(`会话已导入：${path}`);
        }, '生成期间不能导入会话', () => restoreSessionDraft(sessionId, submittedDraft));
      }
      return true;
    }
    if (command.name === 'resume') {
      if (state.recovery?.requiresConfirmation !== true) {
        setOperationError('当前没有待确认的中断回合');
        restoreSessionDraft(sessionId, submittedDraft);
        return true;
      }
      runExclusiveOperation(async () => {
        await controller.resumeInterruptedRun();
        setOperationNotice('已提交中断回合恢复请求');
      }, '当前回合进行中，不能恢复', () => restoreSessionDraft(sessionId, submittedDraft));
      return true;
    }
    if (command.name === 'new') { runSessionOperation(async () => { await controller.createSession(); setOffset(0); }); return true; }
    if (command.name === 'sessions') {
      runSessionOperation(async () => { const result = await controller.listSessions(); setSessions(result); setSessionIndex(0); setSessionFilter(''); setSessionRenaming(false); setSessionDeletePending(null); });
      return true;
    }
    if (command.name === 'diff') { setDiffPanelOpen(value => !value); return true; }
    if (command.name === 'quit') { onExit(); return true; }
    return false;
  };

  const parseLocalCommand = (text: string): LocalCommand | null => {
    const match = text.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const name = match[1]!.toLowerCase();
    const command = UI_COMMANDS.find(item => item.name === name || item.aliases?.includes(name));
    return command === undefined ? null : {name: command.name, args: match[2]?.trim() ?? ''};
  };

  const submit = (text: string, submittedDraft: SessionDraft = currentDraft, sessionId: string | null = activeSessionId) => {
    if (text.trim().length === 0 && submittedDraft.attachments.length === 0) return;
    const local = parseLocalCommand(text);
    if (local !== null) {
      updateDraft('');
      if (runLocalCommand(local, submittedDraft, sessionId)) return;
    }
    const queue = busy || sendingRef.current;
    setSessionDraft(sessionId, emptySessionDraft());
    if (!queue) sendingRef.current = true;
    setOperationError(null);
    setOperationNotice(null);
    if (!queue) setOffset(0);
    void (async () => {
      try {
        if (queue) await controller.steerMessage(text, submittedDraft.attachments);
        else await controller.sendMessage(text, submittedDraft.attachments);
        const result = controller.getState();
        if (result.requestStatus === 'failed') {
          restoreSessionDraft(sessionId, submittedDraft);
          setOperationError(result.visibleError ?? '发送失败，草稿已恢复');
        }
      } catch (error: unknown) {
        setOperationError(error instanceof Error ? error.message : String(error));
        restoreSessionDraft(sessionId, submittedDraft);
      } finally {
        if (!queue) sendingRef.current = false;
      }
    })();
  };

  const slashMatch = /^\/(\S*)$/.exec(draft);
  const paletteVisible = !paletteHidden && slashMatch !== null && !modelPickerOpen && sessions === null && state.approvalPrompt === null;
  const paletteQuery = slashMatch?.[1]?.toLowerCase() ?? '';
  const filteredCommands = paletteVisible
    ? catalog.filter(command => command.name.toLowerCase().startsWith(paletteQuery) || command.aliases?.some(alias => alias.toLowerCase().startsWith(paletteQuery)))
    : [];
  const selectedPaletteIndex = Math.max(0, Math.min(paletteIndex, filteredCommands.length - 1));
  const pageStep = Math.max(1, Math.floor(height / 4));
  const filteredSessionCount = sessions === null ? 0 : filterSessions(sessions, sessionFilter).length;
  const sessionHeight = sessions === null ? 0 : Math.min(filteredSessionCount === 0 ? 1 : filteredSessionCount, 8) + 4 + (sessionRenaming ? 1 : 0) + (sessionDeletePending !== null ? 1 : 0);
  const approvalIndex = state.approvalPrompt !== null && approvalSelection?.callId === state.approvalPrompt.callId
    ? approvalSelection.index
    : 0;

  usePaste(text => updateDraft(value => value + text), {isActive: focus === 'input' && sessions === null && !sessionPending && !switchingModel && !attachmentLoading && state.approvalPrompt === null});
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      if (busy || sendingRef.current) void controller.cancelActiveRequest().catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)));
      else if (!attachmentPendingRef.current) onExit();
      return;
    }
    if (attachmentPendingRef.current) return;
    if (state.approvalPrompt) {
      const callId = state.approvalPrompt.callId;
      if (key.upArrow) { setApprovalSelection({callId, index: Math.max(0, approvalIndex - 1)}); return; }
      if (key.downArrow) { setApprovalSelection({callId, index: Math.min(approvalDecisions.length - 1, approvalIndex + 1)}); return; }
      // 审批是模态的：Esc 等同于“否”，和 Claude Code 一致，不会误触发批准。
      if (key.escape) { controller.resolveToolApproval('denied'); return; }
      if (key.return) { controller.resolveToolApproval(approvalDecisions[approvalIndex] ?? 'denied'); return; }
      if (input.toLowerCase() === 'y' || input === '1') controller.resolveToolApproval('approved');
      else if (input.toLowerCase() === 's' || input === '2') controller.resolveToolApproval('approved_session');
      else if (input.toLowerCase() === 'p' || input === '3') controller.resolveToolApproval('approved_permanent');
      else if (input.toLowerCase() === 'n' || input === '4') controller.resolveToolApproval('denied');
      return;
    }
    if (modelPickerOpen) {
      if (modelStage === 'models') {
        if (key.escape && !switchingModel) { setModelStage('profiles'); setModelList(null); }
        else if (!switchingModel && key.upArrow) setModelModelIndex(value => Math.max(0, value - 1));
        else if (!switchingModel && key.downArrow) setModelModelIndex(value => Math.min((modelList?.models.length ?? 0), value + 1));
        else if (key.return && !switchingModel && modelList !== null && !modelList.loading) {
          const rows = modelList.models.length;
          if (modelModelIndex === 0 || modelModelIndex > rows) switchModel(modelList.name);
          else {
            const model = modelList.models[modelModelIndex - 1];
            if (model !== undefined && model.enabled) switchModel(modelList.name, model.id);
          }
        }
        return;
      }
      if (key.escape && !switchingModel) closeModelPicker();
      else if (!switchingModel && key.upArrow) setModelIndex(value => Math.max(0, value - 1));
      else if (!switchingModel && key.downArrow) setModelIndex(value => Math.min(profiles.length - 1, value + 1));
      else if (key.return && !switchingModel && profiles[modelIndex]) chooseProfileForModels(profiles[modelIndex].name);
      return;
    }
    if (sessionPendingRef.current) return;
    if (sessions !== null) {
      // 历史会话浮层打开时优先截获按键，下面的聊天快捷键不会同时触发。
      const filtered = filterSessions(sessions, sessionFilter);
      const clampIndex = (value: number): number => Math.max(0, Math.min(value, Math.max(0, filtered.length - 1)));
      if (sessionRenaming) {
        if (key.escape) { setSessionRenaming(false); setSessionRenameValue(''); }
        else if (key.return) {
          const target = filtered[sessionIndex];
          const title = sessionRenameValue.trim();
          setSessionRenaming(false);
          setSessionRenameValue('');
          if (target !== undefined && title !== '') runSessionOperation(async () => { await controller.renameSession(target.id, title); setSessions(await controller.listSessions()); });
        }
        else if (key.backspace || key.delete) setSessionRenameValue(value => Array.from(value).slice(0, -1).join(''));
        else if (!key.ctrl && !key.meta && input.length > 0) setSessionRenameValue(value => value + input);
        return;
      }
      if (sessionDeletePending !== null) {
        if (input.toLowerCase() === 'd' || key.return) {
          const target = sessionDeletePending;
          setSessionDeletePending(null);
          runSessionOperation(async () => { await controller.deleteSession(target.id); setSessions(await controller.listSessions()); setSessionIndex(0); });
        } else {
          setSessionDeletePending(null);
        }
        return;
      }
      if (key.escape) {
        if (sessionFilter !== '') setSessionFilter('');
        else setSessions(null);
      }
      else if (key.upArrow) setSessionIndex(value => clampIndex(value - 1));
      else if (key.downArrow) setSessionIndex(value => clampIndex(value + 1));
      else if (key.return && filtered[sessionIndex]) {
        const sessionId = filtered[sessionIndex].id;
        runSessionOperation(async () => { await controller.switchSession(sessionId); setSessions(null); setOffset(0); });
      }
      else if (input.toLowerCase() === 'r' && filtered[sessionIndex] && sessionFilter === '') {
        setSessionRenaming(true);
        setSessionRenameValue('');
      }
      else if (input.toLowerCase() === 'd' && filtered[sessionIndex] && sessionFilter === '') {
        setSessionDeletePending(filtered[sessionIndex]);
      }
      else if (key.backspace || key.delete) setSessionFilter(value => Array.from(value).slice(0, -1).join(''));
      else if (!key.ctrl && !key.meta && input.length > 0 && !key.return) {
        setSessionFilter(value => value + input);
        setSessionIndex(0);
      }
      return;
    }
    if (key.ctrl && (input === '=' || input === '+')) { setDensity(value => Math.min(2, value + 1) as Density); return; }
    if (key.ctrl && input === '-') { setDensity(value => Math.max(0, value - 1) as Density); return; }
    if (paletteVisible) {
      if (key.escape) { setPaletteHidden(true); return; }
      if (key.upArrow) { setPaletteIndex(value => Math.max(0, Math.min(value, filteredCommands.length - 1) - 1)); return; }
      if (key.downArrow) { setPaletteIndex(value => Math.min(Math.max(0, filteredCommands.length - 1), value + 1)); return; }
      if (key.tab && filteredCommands[selectedPaletteIndex]) {
        const command = filteredCommands[selectedPaletteIndex];
        updateDraft(`/${command.name}${command.argumentHint === undefined ? '' : ' '}`);
        return;
      }
      if (key.return) {
        const command = filteredCommands[selectedPaletteIndex];
        if (!command) return;
        if (command.name === 'model') {
          updateDraft('');
          setModelStage('profiles');
          setModelList(null);
          setModelPickerOpen(true);
          const current = profiles.findIndex(profile => profile.name === state.profile?.name);
          setModelIndex(Math.max(0, current));
          return;
        }
        if (UI_COMMANDS.some(item => item.name === command.name)) { updateDraft(''); runLocalCommand({name: command.name, args: ''}); return; }
        if (command.argumentHint !== undefined) { updateDraft(`/${command.name} `); return; }
        updateDraft('');
        submit(`/${command.name}`);
        return;
      }
    }
    if (key.escape && diffPanelOpen) { setDiffPanelOpen(false); return; }
    // 生成中按 Esc 立即中断当前回合；已排队消息随后作为下一回合发出。
    if (key.escape && busy) { void controller.cancelActiveRequest().catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error))); return; }
    if (input === 'n' && key.ctrl) { runLocalCommand({name: 'new', args: ''}); return; }
    if (input === 's' && key.ctrl) { runLocalCommand({name: 'sessions', args: ''}); return; }
    if (input === 'o' && key.ctrl) { setToolCallsExpanded(value => !value); return; }
    if (key.tab) { setFocus(value => value === 'input' ? 'messages' : 'input'); return; }
    if (input === 'l' && key.ctrl) return;
    if (input === 't' && key.ctrl) { setDebugOpen(value => !value); return; }
    if (key.pageUp) { setOffset(value => Math.min(Math.max(0, state.messages.length - 1), value + pageStep)); return; }
    if (key.pageDown) { setOffset(value => Math.max(0, value - pageStep)); return; }
    if (focus === 'messages') {
      const selectedIndex = Math.max(0, state.messages.findIndex(item => item.id === state.selectedMessageId));
      if (key.upArrow && state.messages.length > 0) controller.selectMessage(state.messages[Math.max(0, selectedIndex - 1)]!.id);
      else if (key.downArrow && state.messages.length > 0) controller.selectMessage(state.messages[Math.min(state.messages.length - 1, selectedIndex + 1)]!.id);
      else if (key.return && state.selectedMessageId !== null) controller.toggleThinking(state.selectedMessageId);
      return;
    }
    if (key.return) {
      if (!disabled && (draft.trim().length > 0 || currentDraft.attachments.length > 0)) {
        const submittedDraft = {text: draft, attachments: [...currentDraft.attachments]};
        submit(draft, submittedDraft, activeSessionId);
      }
    } else if (key.backspace || key.delete) {
      // Array.from 按 Unicode 码点拆分，比字符串 slice 更不容易切坏 emoji/中文扩展字符。
      updateDraft(value => Array.from(value).slice(0, -1).join(''));
    } else if (!key.ctrl && !key.meta && input.length > 0) {
      updateDraft(value => value + input);
    }
  });

  const debugHeight = debugOpen ? Math.max(8, Math.floor(height / 3)) : 0;
  const visibleError = operationError ?? state.visibleError;
  const errorHeight = visibleError === null ? 0 : 5;
  const operationNoticeHeight = operationNotice === null ? 0 : wrapFlow(operationNotice, Math.max(1, columns - 4)).length + 1;
  const attachmentNotice = currentDraft.attachments.length === 0
    ? null
    : `待发送图片：${currentDraft.attachments.map(image => `${image.name} · ${image.mediaType}`).join('；')} · /attachments clear 清除`;
  const attachmentHeight = attachmentNotice === null ? 0 : wrapFlow(attachmentNotice, Math.max(1, columns - 4)).length + 1;
  const recoveryNotice = state.recovery?.requiresConfirmation === true
    ? `中断回合待确认 · ${state.recovery.runId.slice(0, 8)}：${state.recovery.message} 输入 /resume 并按 Enter 确认继续；不会重放已完成工具。`
    : null;
  const recoveryHeight = recoveryNotice === null ? 0 : wrapFlow(recoveryNotice, Math.max(1, columns - 8)).length + 2;
  const paletteHeight = paletteVisible ? Math.min(filteredCommands.length, 6) + 4 : 0;
  const modelHeight = modelPickerOpen ? Math.min(modelStage === 'models' ? (modelList?.models.length ?? 0) + 2 : profiles.length, 8) + 5 : 0;

  const approvalHeight = state.approvalPrompt === null ? 0 : 10;
  // 排队面板：上下边框各一行 + 标题一行 + 每条消息一行。
  const queueHeight = state.queuedMessages.length === 0 ? 0 : state.queuedMessages.length + 3;
  const conversationHeight = Math.max(4, height - 10 - (busy ? 1 : 0) - (toolCallsExpanded ? 1 : 0) - errorHeight - operationNoticeHeight - attachmentHeight - recoveryHeight - paletteHeight - modelHeight - sessionHeight - approvalHeight - debugHeight - queueHeight);
  const panelWidth = diffPanelOpen ? Math.max(24, Math.min(42, Math.floor(Math.max(columns, 80) / 4))) : 0;
  const permission = state.permissionTier === 'strict' ? '严格' : state.permissionTier === 'bypass' ? '放行' : '默认';

  return <Box flexDirection="row" height={height} width={columns} backgroundColor={theme.bg}>
    <Box flexDirection="column" height={height} flexGrow={1}>
      <Header state={state} workspace={workspace} />
      <StatusBar state={state} />
      {recoveryNotice === null ? null : <Box borderStyle="round" borderColor={theme.yellow} paddingX={1} marginX={1} marginBottom={1}><Text color={theme.yellow} wrap="wrap">{recoveryNotice}</Text></Box>}
      <ErrorBanner message={visibleError} />
      {operationNotice === null ? null : <Box paddingX={1} marginBottom={1}><Text color={theme.accent} wrap="wrap">{operationNotice}</Text></Box>}
      <MessageList messages={state.messages} height={conversationHeight} offset={offset}
        selectedMessageId={state.selectedMessageId} expandedThinkingIds={state.expandedThinkingIds} toolCalls={state.toolCalls}
        liveToolCalls={state.liveToolCalls} toolCallsExpanded={toolCallsExpanded} density={density} spinner={spinner}
        width={Math.max(40, columns - panelWidth)} />
      <Activity state={state} spinner={spinner} />
      {toolCallsExpanded ? <Box paddingX={1}><Text color={theme.faint}>工具详情已展开 · Ctrl+O 切换</Text></Box> : null}
      {paletteVisible ? <SlashMenu commands={filteredCommands} selectedIndex={selectedPaletteIndex} /> : null}
      {modelPickerOpen ? <ModelPicker profiles={profiles} selectedIndex={modelIndex} currentName={state.profile?.name ?? ''} switching={switchingModel} stage={modelStage}
        {...(modelList === null ? {} : {
          modelProfile: {name: modelList.name, model: profiles.find(profile => profile.name === modelList.name)?.model ?? ''},
          models: modelList.models,
          modelsLoading: modelList.loading,
          ...(modelList.note === undefined ? {} : {modelsNote: modelList.note}),
          ...(modelList.error === undefined ? {} : {modelsError: modelList.error}),
          modelSelectedIndex: modelModelIndex,
        })} /> : null}
      {sessions === null ? null : <SessionList sessions={filterSessions(sessions, sessionFilter)} selectedIndex={sessionIndex} totalCount={sessions.length} filter={sessionFilter} renaming={sessionRenaming} renameValue={sessionRenameValue} deletePending={sessionDeletePending} />}
      {state.approvalPrompt ? <ToolApprovalPanel prompt={state.approvalPrompt} selectedIndex={approvalIndex} /> : null}
      {debugOpen ? <DebugPanel state={state} controller={controller} height={debugHeight} /> : null}
      <QueuedMessages messages={state.queuedMessages} />
      {attachmentLoading ? <Box paddingX={1}><Text color={theme.faint}>正在读取图片…</Text></Box> : null}
      {attachmentNotice === null ? null : <Box paddingX={1} marginBottom={1}><Text color={theme.accent} wrap="wrap">{attachmentNotice}</Text></Box>}
      <PromptInput value={draft} focused={focus === 'input'} disabled={disabled} width={Math.max(20, columns - panelWidth)}
        model={state.profile?.model ?? '-'} mode={state.agentMode === 'plan' ? 'PLAN' : 'DO'} permission={permission} />
    </Box>
    {diffPanelOpen ? <DiffPanel records={state.toolCalls} width={panelWidth} /> : null}
  </Box>;
}
