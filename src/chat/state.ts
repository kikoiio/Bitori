import type {ProfileSummary} from '../config/types.js';
import type {Usage} from '../providers/types.js';
import type {Session, StoredMessage} from '../storage/types.js';
import type {ToolCallRecord} from '../storage/types.js';
import type {ToolApprovalPrompt} from '../tools/types.js';
import type {AgentMode, AgentPhase, AgentStopReason} from '../agent/types.js';
import type {PermissionTier} from '../tools/permission-engine.js';

/** 当前要显示的顶层页面，以及一次请求在 UI 中可能出现的状态。 */
export type Screen = 'profile_select' | 'chat' | 'session_list' | 'terminal_too_small';
export type RequestStatus = 'idle' | 'thinking' | 'streaming' | 'approving' | 'executing_tools' | 'cancelling' | 'failed';

/** 模型流里已经开始、但尚未完成一整轮迭代的工具调用；用于即时展示。 */
export interface LiveToolCall {
  callId: string;
  iterationId: string;
  name: string;
  argumentsText: string;
  ready: boolean;
}

/**
 * TUI 的单一状态快照。控制器每次都创建新对象发布，React 据此判断是否重渲染。
 */
export interface AppState {
  screen: Screen;
  profile: ProfileSummary | null;
  session: Session | null;
  messages: StoredMessage[];
  requestStatus: RequestStatus;
  latestUsage: Usage | null;
  expandedThinkingIds: Set<string>;
  selectedMessageId: string | null;
  visibleError: string | null;
  toolCalls: ToolCallRecord[];
  liveToolCalls: LiveToolCall[];
  approvalPrompt: ToolApprovalPrompt | null;
  agentMode: AgentMode;
  activeRunId: string | null;
  /** 生成中排队、尚未注入模型的消息；界面上以“已排队”展示。 */
  queuedMessages: string[];
  recovery: {runId: string; requiresConfirmation: boolean; message: string} | null;
  iteration: number;
  maxIterations: number;
  agentPhase: AgentPhase | null;
  runUsage: Usage;
  stopReason: AgentStopReason | null;
  permissionTier: PermissionTier;
  /** 调试面板开关；面板内容实时从控制器 tap 读取。 */
  debugOpen: boolean;
}

export function initialAppState(profile: ProfileSummary | null = null): AppState {
  return {
    screen: profile === null ? 'profile_select' : 'chat',
    profile,
    session: null,
    messages: [],
    requestStatus: 'idle',
    latestUsage: null,
    expandedThinkingIds: new Set(),
    selectedMessageId: null,
    visibleError: null,
    toolCalls: [], liveToolCalls: [], approvalPrompt: null,
    agentMode: 'execute', activeRunId: null, queuedMessages: [], recovery: null, iteration: 0, maxIterations: 20,
    agentPhase: null, runUsage: {inputTokens: 0, outputTokens: 0}, stopReason: null,
    permissionTier: 'default',
    debugOpen: false,
  };
}

export function replaceMessage(state: AppState, message: StoredMessage): AppState {
  // 不原地修改数组：map 生成新数组，只有 id 匹配的那一项被替换。
  return {...state, messages: state.messages.map(item => item.id === message.id ? message : item)};
}
