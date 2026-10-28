import type {FinalMessageUpdate, ToolCallRecord} from './types.js';
import type {AgentMode, AgentRunResult} from '../agent/types.js';

/** 主线程允许发给存储 Worker 的全部命令，是一个以 type 区分的联合类型。 */
export type StorageOperation =
  | {type: 'initialize'}
  | {type: 'find_latest_session'; profileName: string}
  | {type: 'list_sessions'; profileName: string}
  | {type: 'create_session'; profileName: string}
  | {type: 'get_session'; sessionId: string}
  | {type: 'get_messages'; sessionId: string}
  | {type: 'get_conversation'; sessionId: string}
  | {type: 'save_tool_batch'; records: ToolCallRecord[]}
  | {type: 'finalize_assistant_with_tool_batch'; messageId: string; update: FinalMessageUpdate; records: ToolCallRecord[]}
  | {type: 'update_tool_call'; record: ToolCallRecord}
  | {type: 'begin_turn'; sessionId: string; text: string}
  | {type: 'begin_assistant_continuation'; sessionId: string}
  | {type: 'checkpoint_assistant'; messageId: string; content: string; thinking: string}
  | {type: 'finalize_message'; messageId: string; update: FinalMessageUpdate}
  | {type: 'set_session_mode'; sessionId: string; mode: AgentMode}
  | {type: 'begin_agent_run'; runId: string; sessionId: string; displayText: string; mode: AgentMode}
  | {type: 'begin_agent_iteration'; messageId: string; runId: string; sessionId: string; iteration: number}
  | {type: 'finalize_iteration_with_tool_batch'; messageId: string; update: FinalMessageUpdate; records: ToolCallRecord[]}
  | {type: 'finish_agent_run'; runId: string; result: AgentRunResult; latestPlanMessageId?: string}
  | {type: 'close'};

export interface StorageRequest {
  // requestId 用于把异步返回值配对到发起请求的 Promise。
  requestId: string;
  operation: StorageOperation;
}

/** Error 对象不能依赖原型跨线程传递，因此只序列化安全且需要的字段。 */
export interface SerializedStorageError {
  name: string;
  message: string;
}

export type StorageResponse =
  | {requestId: string; result: unknown}
  | {requestId: string; error: SerializedStorageError};
