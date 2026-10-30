import {Box, Text, useInput, usePaste, useWindowSize} from 'ink';
import {useRef, useState} from 'react';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';
import type {Session} from '../../storage/types.js';
import {DebugPanel} from '../components/debug-panel.js';
import {DiffPanel} from '../components/diff-panel.js';
import {ErrorBanner} from '../components/error-banner.js';
import {MessageList} from '../components/message-list.js';
import {PromptInput} from '../components/prompt-input.js';
import {SessionList} from '../components/session-list.js';
import {StatusBar} from '../components/status-bar.js';
import {ToolApprovalPanel} from '../components/tool-approval-panel.js';

export interface ChatScreenProps {state: AppState; controller: ChatController; height: number; onExit: () => void}

/** 聊天页负责把键盘/粘贴事件翻译成 controller 操作，并组合各展示组件。 */
export function ChatScreen({state, controller, height, onExit}: ChatScreenProps) {
  const {columns} = useWindowSize();
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState<'input' | 'messages'>('input');
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionIndex, setSessionIndex] = useState(0);
  const [sessionPending, setSessionPending] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const sessionPendingRef = useRef(false);
  const sendingRef = useRef(false);
  // failed 已经是一次请求的终态，不阻止用户继续发送；下面三种状态才算 busy。
  const busy = state.requestStatus !== 'idle' && state.requestStatus !== 'failed';

  const runSessionOperation = (operation: () => Promise<void>) => {
    if (sessionPendingRef.current || sendingRef.current || busy) return;
    sessionPendingRef.current = true;
    setSessionPending(true);
    setOperationError(null);
    void Promise.resolve().then(operation).catch((error: unknown) => {
      setOperationError(error instanceof Error ? error.message : String(error));
    }).finally(() => { sessionPendingRef.current = false; setSessionPending(false); });
  };

  usePaste(text => setDraft(value => value + text), {isActive: focus === 'input' && sessions === null && !sessionPending});
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      if (busy || sendingRef.current) void controller.cancelActiveRequest().catch((error: unknown) => setOperationError(error instanceof Error ? error.message : String(error))); else onExit();
      return;
    }
    if (state.approvalPrompt) {
      if (input.toLowerCase() === 'y' || input === '1') controller.resolveToolApproval('approved');
      else if (input.toLowerCase() === 's' || input === '2') controller.resolveToolApproval('approved_session');
      else if (input.toLowerCase() === 'p' || input === '3') controller.resolveToolApproval('approved_permanent');
      else if (input.toLowerCase() === 'n' || input === '4') controller.resolveToolApproval('denied');
      return;
    }
    if (sessionPendingRef.current) return;
    if (sessions !== null) {
      // 历史会话浮层打开时优先截获按键，下面的聊天快捷键不会同时触发。
      if (key.escape) setSessions(null);
      else if (key.upArrow) setSessionIndex(value => Math.max(0, value - 1));
      else if (key.downArrow) setSessionIndex(value => Math.min(sessions.length - 1, value + 1));
      else if (key.return && sessions[sessionIndex]) {
        const sessionId = sessions[sessionIndex].id;
        runSessionOperation(async () => { await controller.switchSession(sessionId); setSessions(null); });
      }
      return;
    }
    if (key.escape && diffPanelOpen) { setDiffPanelOpen(false); return; }
    if (input === 'n' && key.ctrl) { runSessionOperation(() => controller.createSession()); return; }
    if (input === 's' && key.ctrl) {
      runSessionOperation(async () => { const result = await controller.listSessions(); setSessions(result); setSessionIndex(0); });
      return;
    }
    if (input === 'o' && key.ctrl) { setToolCallsExpanded(value => !value); return; }
    if (key.tab) { setFocus(value => value === 'input' ? 'messages' : 'input'); return; }
    if (input === 'l' && key.ctrl) return;
    if (input === 't' && key.ctrl) { controller.toggleDebugPanel(); return; }
    if (key.pageUp) { setOffset(value => Math.min(state.messages.length - 1, value + 1)); return; }
    if (key.pageDown) { setOffset(value => Math.max(0, value - 1)); return; }
    if (focus === 'messages') {
      const selectedIndex = Math.max(0, state.messages.findIndex(item => item.id === state.selectedMessageId));
      if (key.upArrow && state.messages.length > 0) controller.selectMessage(state.messages[Math.max(0, selectedIndex - 1)]!.id);
      else if (key.downArrow && state.messages.length > 0) controller.selectMessage(state.messages[Math.min(state.messages.length - 1, selectedIndex + 1)]!.id);
      else if (key.return && state.selectedMessageId !== null) controller.toggleThinking(state.selectedMessageId);
      return;
    }
    if (key.return) {
      if (draft.trim() === '/diff') {
        setDraft('');
        setDiffPanelOpen(value => !value);
        return;
      }
      if (!busy && !sendingRef.current && draft.trim().length > 0) {
        const message = draft;
        setDraft('');
        sendingRef.current = true;
        setOperationError(null);
        void (async () => {
          try { await controller.sendMessage(message); }
          catch (error: unknown) { setOperationError(error instanceof Error ? error.message : String(error)); }
          finally { sendingRef.current = false; }
        })();
      }
    } else if (key.backspace || key.delete) {
      // Array.from 按 Unicode 码点拆分，比字符串 slice 更不容易切坏 emoji/中文扩展字符。
      setDraft(value => Array.from(value).slice(0, -1).join(''));
    } else if (!key.ctrl && !key.meta && input.length > 0) {
      setDraft(value => value + input);
    }
  });

  const debugHeight = state.debugOpen ? Math.max(8, Math.floor(height / 3)) : 0;
  const visibleError = operationError ?? state.visibleError;
  const verboseHint = toolCallsExpanded ? 1 : 0;
  const messageHeight = Math.max(5, height - 7 - (visibleError === null ? 0 : 3) - debugHeight - verboseHint);
  const panelWidth = diffPanelOpen ? Math.max(24, Math.min(42, Math.floor(Math.max(columns, 80) / 4))) : 0;

  return <Box flexDirection="row" height={height}>
    <Box flexDirection="column" height={height} flexGrow={1}>
      <StatusBar state={state} />
      <ErrorBanner message={visibleError} />
      <MessageList messages={state.messages} height={messageHeight} offset={offset}
        selectedMessageId={state.selectedMessageId} expandedThinkingIds={state.expandedThinkingIds} toolCalls={state.toolCalls} toolCallsExpanded={toolCallsExpanded} />
      {state.approvalPrompt ? <ToolApprovalPanel prompt={state.approvalPrompt} /> : null}
      {state.debugOpen ? <DebugPanel state={state} controller={controller} height={debugHeight} /> : null}
      {toolCallsExpanded ? <Text dimColor>详细工具记录 · Ctrl+O 切换</Text> : null}
      <PromptInput value={draft} focused={focus === 'input'} disabled={busy || sessionPending} />
      {sessions === null ? null : <SessionList sessions={sessions} selectedIndex={sessionIndex} />}
      {sessions !== null && operationError !== null ? <Box position="absolute" marginTop={6}><ErrorBanner message={operationError} /></Box> : null}
    </Box>
    {diffPanelOpen ? <DiffPanel records={state.toolCalls} width={panelWidth} /> : null}
  </Box>;
}
