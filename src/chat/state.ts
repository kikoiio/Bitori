import type {ProfileSummary} from '../config/types.js';
import type {Usage} from '../providers/types.js';
import type {Session, StoredMessage} from '../storage/types.js';
import type {ToolCallRecord} from '../storage/types.js';
import type {ToolApprovalPrompt} from '../tools/types.js';
import type {AgentMode, AgentPhase, AgentStopReason} from '../agent/types.js';
import type {PermissionTier} from '../tools/permission-engine.js';

/** [s01] 当前要显示的顶层页面，以及一次请求在 UI 中可能出现的状态。 */
export type Screen = 'profile_select' | 'chat' | 'session_list' | 'terminal_too_small';
/* [s01 旧实现，s02 替换] RequestStatus 不含 approving 与 executing_tools。 */
export type RequestStatus = 'idle' | 'thinking' | 'streaming' | 'approving' | 'executing_tools' | 'cancelling' | 'failed';

/** [s01]
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
  approvalPrompt: ToolApprovalPrompt | null;
  agentMode: AgentMode;
  activeRunId: string | null;
  iteration: number;
  maxIterations: number;
  agentPhase: AgentPhase | null;
  runUsage: Usage;
  stopReason: AgentStopReason | null;
  permissionTier: PermissionTier;
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
    toolCalls: [], approvalPrompt: null,
    agentMode: 'execute', activeRunId: null, iteration: 0, maxIterations: 20,
    agentPhase: null, runUsage: {inputTokens: 0, outputTokens: 0}, stopReason: null,
    permissionTier: 'default',
  };
}

export function replaceMessage(state: AppState, message: StoredMessage): AppState {
  // [s01] 不原地修改数组：map 生成新数组，只有 id 匹配的那一项被替换。
  return {...state, messages: state.messages.map(item => item.id === message.id ? message : item)};
}
