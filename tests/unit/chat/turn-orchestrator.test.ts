import {describe, expect, it} from 'vitest';
import {agentLoopLimitMessage, createAgentLoopLimitResult, createFinalChatRequest} from '../../../src/chat/turn-orchestrator.js';

describe('TurnOrchestrator 策略', () => {
  it('final 请求不携带工具定义且只保留一次回灌上下文', () => { const request = createFinalChatRequest([{role: 'user', content: 'hi'}], [{callId: 'p', name: 'read_file', arguments: {path: 'a'}}], [{callId: 'p', name: 'read_file', result: {status: 'success', output: {content: 'x'}}}]); expect(request).toMatchObject({phase: 'final', toolCalls: [{callId: 'p'}], toolResults: [{callId: 'p'}]}); expect(request.tools).toBeUndefined(); });
  it('第二批调用只生成 agent_loop_limit 结构化结果', () => expect(createAgentLoopLimitResult()).toEqual({status: 'error', error: {code: 'agent_loop_limit', message: agentLoopLimitMessage, retryable: false}}));
});
