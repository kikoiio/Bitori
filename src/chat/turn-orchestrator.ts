import type {ChatMessage, ChatRequest, HistoricalToolCall} from '../providers/types.js';
import type {JsonObject, ToolExecutionResult} from '../tools/types.js';

export const agentLoopLimitMessage = '已达到本轮工具执行限制，后续工具调用未执行';

/** [s02] final 请求统一不携带工具定义，从类型构造处阻止第三阶段。 */
export function createFinalChatRequest(messages: ChatMessage[], toolCalls: Array<{callId: string; name: string; arguments: JsonObject}>, toolResults: ChatRequest['toolResults'], toolHistory?: HistoricalToolCall[]): ChatRequest {
  return {messages, phase: 'final', toolCalls, ...(toolResults ? {toolResults} : {}), ...(toolHistory ? {toolHistory} : {})};
}

/** [s02] final 流中的任何新调用只能形成可持久化的限制结果。 */
export function createAgentLoopLimitResult(): ToolExecutionResult {
  return {status: 'error', error: {code: 'agent_loop_limit', message: agentLoopLimitMessage, retryable: false}};
}
