import {Box, Text, useInput, usePaste, useWindowSize} from 'ink';
import {useMemo, useRef, useState} from 'react';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';
import type {ProfileSummary} from '../../config/types.js';
import type {RemoteModel} from '../../diagnostics/connection.js';
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
  {name: 'model', description: '切换模型配置', argumentHint: '<name>'},
  {name: 'new', description: '新建会话'},
  {name: 'sessions', description: '打开历史会话'},
  {name: 'diff', description: '查看本次会话的代码改动'},
  {name: 'help', description: '浏览全部命令'},
  {name: 'quit', description: '退出 Bitori', aliases: ['exit', 'q']},
];

const approvalDecisions: readonly ApprovalDecision[] = ['approved', 'approved_session', 'approved_permanent', 'denied'];

interface LocalCommand {name: string; args: string}

/** 聊天页负责把键盘/粘贴事件翻译成 controller 操作，并组合各展示组件。 */
export function ChatScreen({state, controller, height, onExit, profiles = [], onSwitchProfile, listModels, workspace}: ChatScreenProps) {
  const {columns} = useWindowSize();
  const [draft, setDraft] = useState('');
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
  // failed 已经是一次请求的终态，不阻止用户继续发送；其余进行中状态才算 busy。
  const busy = state.requestStatus !== 'idle' && state.requestStatus !== 'failed';
  const spinner = useSpinner(busy);
  // 生成期间输入框不锁死：允许随时打字，Enter 走排队而不是被忽略。
  // 审批是模态的：此时输入归审批面板，真实光标也收起来。
  const disabled = sessionPending || switchingModel || state.approvalPrompt !== null;
  const catalog = useMemo(() => {
    const merged = new Map<string, PaletteCommand>();
    for (const command of [...UI_COMMANDS, ...(controller.commandCatalog?.() ?? [])]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [controller]);
  const updateDraft = (next: string | ((value: string) => string)) => {
    setDraft(next);
    setPaletteIndex(0);
    setPaletteHidden(false);
  };

  const runSessionOperation = (operation: () => Promise<void>) => {
    if (sessionPendingRef.current || sendingRef.current || busy || switchingRef.current) {
      setOperationError('生成期间不能切换会话');
      return;
    }
    sessionPendingRef.current = true;
    setSessionPending(true);
    setOperationError(null);
    void Promise.resolve().then(operation).catch((error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error));
    }).finally(() => { sessionPendingRef.current = false; setSessionPending(false); });
  };

  const switchModel = (name: string, modelOverride?: string) => {
    if (switchingRef.current) return;
    const profile = profiles.find(item => item.name === name) ?? profiles.find(item => item.model === name);
    if (!profile) { setOperationError(`未知模型配置：${name}`); return; }
    if (profile.name === state.profile?.name && modelOverride === undefined) { setModelPickerOpen(false); return; }
    if (busy || sessionPendingRef.current || sendingRef.current) { setOperationError('生成期间不能切换模型'); return; }
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
    if (busy || sessionPendingRef.current || sendingRef.current) { setOperationError('生成期间不能切换模型'); return; }
    setModelStage('models');
    setModelModelIndex(0);
    setModelList({name, models: [], loading: true});
    void listModels(name).then(result => {
      setModelList({name, models: result.models, loading: false, ...(result.note === undefined ? {} : {note: result.note}), ...(result.error === undefined ? {} : {error: result.error})});
    }).catch((error: unknown) => {
      setModelList({name, models: [], loading: false, error: error instanceof Error ? error.message : String(error)});
    });
  };

  const runLocalCommand = (command: LocalCommand): boolean => {
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

  const submit = (text: string) => {
    if (text.trim().length === 0) return;
    const local = parseLocalCommand(text);
    if (local !== null && runLocalCommand(local)) return;
    if (busy) {
      // 生成中：新消息排队，模型在当前回合的下一个边界读到它（同一回合内转向）。
      void controller.steerMessage(text).catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setOperationError(null);
    setOffset(0);
    void (async () => {
      try { await controller.sendMessage(text); }
      catch (error: unknown) { setOperationError(error instanceof Error ? error.message : String(error)); }
      finally { sendingRef.current = false; }
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

  usePaste(text => updateDraft(value => value + text), {isActive: focus === 'input' && sessions === null && !sessionPending && !switchingModel && state.approvalPrompt === null});
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      if (busy || sendingRef.current) void controller.cancelActiveRequest().catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error))); else onExit();
      return;
    }
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
      if (!disabled && draft.trim().length > 0) {
        const message = draft;
        updateDraft('');
        submit(message);
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
  const paletteHeight = paletteVisible ? Math.min(filteredCommands.length, 6) + 4 : 0;
  const modelHeight = modelPickerOpen ? Math.min(modelStage === 'models' ? (modelList?.models.length ?? 0) + 2 : profiles.length, 8) + 5 : 0;

  const approvalHeight = state.approvalPrompt === null ? 0 : 10;
  // 排队面板：上下边框各一行 + 标题一行 + 每条消息一行。
  const queueHeight = state.queuedMessages.length === 0 ? 0 : state.queuedMessages.length + 3;
  const conversationHeight = Math.max(4, height - 10 - (busy ? 1 : 0) - (toolCallsExpanded ? 1 : 0) - errorHeight - paletteHeight - modelHeight - sessionHeight - approvalHeight - debugHeight - queueHeight);
  const panelWidth = diffPanelOpen ? Math.max(24, Math.min(42, Math.floor(Math.max(columns, 80) / 4))) : 0;
  const permission = state.permissionTier === 'strict' ? '严格' : state.permissionTier === 'bypass' ? '放行' : '默认';

  return <Box flexDirection="row" height={height} width={columns} backgroundColor={theme.bg}>
    <Box flexDirection="column" height={height} flexGrow={1}>
      <Header state={state} workspace={workspace} />
      <StatusBar state={state} />
      <ErrorBanner message={visibleError} />
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
      <PromptInput value={draft} focused={focus === 'input'} disabled={disabled} width={Math.max(20, columns - panelWidth)}
        model={state.profile?.model ?? '-'} mode={state.agentMode === 'plan' ? 'PLAN' : 'DO'} permission={permission} />
    </Box>
    {diffPanelOpen ? <DiffPanel records={state.toolCalls} width={panelWidth} /> : null}
  </Box>;
}
