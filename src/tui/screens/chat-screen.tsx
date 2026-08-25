import {Box, useInput, usePaste} from 'ink';
import {useState} from 'react';
import type {ChatController} from '../../chat/controller.js';
import type {AppState} from '../../chat/state.js';
import type {Session} from '../../storage/types.js';
import {ErrorBanner} from '../components/error-banner.js';
import {MessageList} from '../components/message-list.js';
import {PromptInput} from '../components/prompt-input.js';
import {SessionList} from '../components/session-list.js';
import {StatusBar} from '../components/status-bar.js';
import {ToolApprovalPanel} from '../components/tool-approval-panel.js';

export interface ChatScreenProps {state: AppState; controller: ChatController; height: number; onExit: () => void}

/** [s01] 聊天页负责把键盘/粘贴事件翻译成 controller 操作，并组合各展示组件。 */
export function ChatScreen({state, controller, height, onExit}: ChatScreenProps) {
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState<'input' | 'messages'>('input');
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [sessionIndex, setSessionIndex] = useState(0);
  // [s01] failed 已经是一次请求的终态，不阻止用户继续发送；下面三种状态才算 busy。
  const busy = state.requestStatus !== 'idle' && state.requestStatus !== 'failed';

  // [s01] 粘贴可能一次带来多行 Unicode 文本，单独使用 usePaste 避免被逐键逻辑破坏。
  usePaste(text => setDraft(value => value + text), {isActive: focus === 'input' && sessions === null});
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) {
      if (busy) void controller.cancelActiveRequest(); else onExit();
      return;
    }
    if (state.approvalPrompt) {
      if (input.toLowerCase() === 'y') controller.resolveToolApproval('approved');
      else if (input.toLowerCase() === 's') controller.resolveToolApproval('approved_session');
      else if (input.toLowerCase() === 'p') controller.resolveToolApproval('approved_permanent');
      else if (input.toLowerCase() === 'n') controller.resolveToolApproval('denied');
      return;
    }
    if (sessions !== null) {
      // [s01] 历史会话浮层打开时优先截获按键，下面的聊天快捷键不会同时触发。
      if (key.escape) setSessions(null);
      else if (key.upArrow) setSessionIndex(value => Math.max(0, value - 1));
      else if (key.downArrow) setSessionIndex(value => Math.min(sessions.length - 1, value + 1));
      else if (key.return && sessions[sessionIndex]) {
        void controller.switchSession(sessions[sessionIndex].id).then(() => setSessions(null));
      }
      return;
    }
    if (input === 'n' && key.ctrl) { void controller.createSession(); return; }
    if (input === 'o' && key.ctrl) {
      void controller.listSessions().then(result => { setSessions(result); setSessionIndex(0); });
      return;
    }
    if (key.tab) { setFocus(value => value === 'input' ? 'messages' : 'input'); return; }
    // [s01] offset=0 表示视图贴近最新消息；PageUp 增大 offset，相当于向历史移动。
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
      if (!busy && draft.trim().length > 0) {
        const message = draft;
        setDraft('');
        void controller.sendMessage(message);
      }
    } else if (key.backspace || key.delete) {
      // [s01] Array.from 按 Unicode 码点拆分，比字符串 slice 更不容易切坏 emoji/中文扩展字符。
      setDraft(value => Array.from(value).slice(0, -1).join(''));
    } else if (!key.ctrl && !key.meta && input.length > 0) {
      setDraft(value => value + input);
    }
  });

  // [s01] 为状态栏、错误框和输入框预留高度，其余空间交给消息区，且至少保留 5 行。
  const messageHeight = Math.max(5, height - 7 - (state.visibleError === null ? 0 : 3));
  return <Box flexDirection="column" height={height}>
    <StatusBar state={state} />
    <ErrorBanner message={state.visibleError} />
    <MessageList messages={state.messages} height={messageHeight} offset={offset}
      selectedMessageId={state.selectedMessageId} expandedThinkingIds={state.expandedThinkingIds} toolCalls={state.toolCalls} />
    {state.approvalPrompt ? <ToolApprovalPanel prompt={state.approvalPrompt} /> : null}
    <PromptInput value={draft} focused={focus === 'input'} disabled={busy} />
    {sessions === null ? null : <SessionList sessions={sessions} selectedIndex={sessionIndex} />}
  </Box>;
}
