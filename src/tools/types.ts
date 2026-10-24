/** [s02] 工具域只交换可安全序列化的 JSON 对象。 */
export type JsonObject = Record<string, unknown>;
export type ToolEffect = 'read' | 'write' | 'command';

export interface ToolDefinition {name: string; description: string; inputSchema: JsonObject; strict?: boolean}
export interface ToolLimits {timeoutMs: number; maxResultBytes: number; maxMatches: number}
export interface ToolContext {workspaceRoot: string; signal: AbortSignal; limits: ToolLimits}

export type ToolErrorCode =
  | 'invalid_arguments' | 'unknown_tool' | 'tool_unavailable_in_mode'
  | 'path_outside_workspace' | 'path_not_found' | 'path_already_exists'
  | 'not_a_file' | 'binary_file' | 'invalid_utf8' | 'permission_denied'
  | 'no_unique_match' | 'command_failed' | 'timeout' | 'denied'
  | 'interrupted' | 'agent_loop_limit' | 'hook_rejected' | 'mcp_error' | 'internal_error';
export interface ToolError {code: ToolErrorCode; message: string; retryable: boolean; details?: JsonObject}
export interface TruncationInfo {truncated: boolean; originalUnits: number; returnedUnits: number; unit: 'bytes' | 'matches'}
export type ToolExecutionResult =
  | {status: 'success'; output: JsonObject; truncation?: TruncationInfo}
  | {status: 'error'; error: ToolError; partialOutput?: JsonObject; truncation?: TruncationInfo}
  | {status: 'denied' | 'timeout' | 'interrupted'; error: ToolError; partialOutput?: JsonObject; truncation?: TruncationInfo};

export interface Tool<TArgs extends JsonObject = JsonObject> {
  readonly name: string; readonly description: string; readonly effect: ToolEffect; readonly inputSchema: JsonObject;
  readonly strict?: boolean;
  parseArguments(input: unknown): TArgs;
  execute(args: TArgs, context: ToolContext): Promise<ToolExecutionResult>;
}
export interface ToolCallDraft {internalId: string; providerCallId: string | null; position: number; name: string; argumentsText: string}
export interface ToolCall {internalId: string; providerCallId: string; position: number; name: string; arguments: JsonObject; effect: ToolEffect}
export interface InvalidToolCall extends ToolCallDraft {error: ToolError}
export interface AssembledToolBatch {validCalls: ToolCall[]; invalidCalls: InvalidToolCall[]}
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'denied';
/** [s05] 审批保留旧 approved 别名，并增加一次、会话和永久放行。 */
export type ApprovalDecision = 'approved' | 'approved_once' | 'approved_session' | 'approved_permanent' | 'denied';
export type ToolExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'skipped' | 'interrupted';
export interface ToolApprovalPrompt {callId: string; toolName: string; effect: ToolEffect; argumentSummary: string; riskMessage: string | null; reason?: string}

/** [s03] 完整调用只有 available 分支可进入执行器。 */
export type ToolAvailability = 'available' | 'unknown' | 'invalid' | 'unavailable_in_mode';
export type PreparedToolCall =
  | {availability: 'available'; call: ToolCall; argumentsText: string}
  | {availability: Exclude<ToolAvailability, 'available'>; draft: ToolCallDraft; result: ToolExecutionResult};
