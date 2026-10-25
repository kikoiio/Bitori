import {describe, expect, it} from 'vitest';
import type {LLMClient, ModelContextItem, StreamEvent} from '../../../src/providers/types.js';
import {computeKeepStartIndex, manageContext} from '../../../src/compact/compact.js';
import {estimateContextTokens, usageAnchorFrom} from '../../../src/shared/token-estimate.js';
import {RecoveryState} from '../../../src/compact/recovery.js';
import type {ToolDefinition} from '../../../src/tools/types.js';

function user(content: string): ModelContextItem { return {type: 'message', messageId: content, role: 'user', content}; }
function assistant(content: string): ModelContextItem { return {type: 'assistant_iteration', messageId: content, content, toolCalls: []}; }
function client(text: string): LLMClient {
  return {
    async *streamChat(): AsyncIterable<StreamEvent> {
      yield {type: 'text_delta', text: `<summary>${text}</summary>`};
      yield {type: 'completed', finishReason: 'stop'};
    },
  };
}
const tools: ToolDefinition[] = [{name: 'read_file', description: '读取文件', inputSchema: {type: 'object'}}];

describe('全量上下文压缩', () => {
  it('usage 锚点只替换不累加', () => {
    const items = [user('hello'), assistant('hi')];
    const anchor = usageAnchorFrom({inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 10}, items);
    expect(anchor.tokens).toBe(160);
    expect(estimateContextTokens([...items, user('世界')], anchor)).toBeGreaterThan(anchor.tokens);
  });

  it('近期原文边界同时满足条数与 token 下界的方向', () => {
    const items = Array.from({length: 12}, (_, index) => index < 11 ? user(`消息 ${index}`) : user('长'.repeat(40_000)));
    expect(computeKeepStartIndex(items)).toBeLessThanOrEqual(items.length - 5);
  });

  it('低于阈值不触发摘要，手动强制触发', async () => {
    const items = Array.from({length: 10}, (_, index) => user(`消息 ${index}`));
    const base = {items, client: client('摘要结果'), contextWindow: 200_000, tracking: {consecutiveFailures: 0}, recovery: new RecoveryState(), tools, anchor: null, signal: new AbortController().signal};
    await expect(manageContext(base)).resolves.toMatchObject({compacted: false, reason: 'below_threshold'});
    await expect(manageContext(base, {force: true})).resolves.toMatchObject({compacted: true, reason: 'manual'});
  });

  it('摘要失败计入熔断，成功清零', async () => {
    const items = Array.from({length: 10}, (_, index) => user(`消息 ${index}`));
    const failing: LLMClient = {async *streamChat(): AsyncIterable<StreamEvent> { yield {type: 'error', error: {code: 'provider_error', message: '失败', retryable: false}}; }};
    const tracking = {consecutiveFailures: 0};
    const base = {items, client: failing, contextWindow: 10, tracking, recovery: new RecoveryState(), tools, anchor: null, signal: new AbortController().signal};
    await expect(manageContext(base, {force: true})).rejects.toThrow('上下文压缩失败');
    expect(tracking.consecutiveFailures).toBe(1);
    const success = {...base, client: client('成功')};
    await expect(manageContext(success, {force: true})).resolves.toMatchObject({compacted: true});
    expect(tracking.consecutiveFailures).toBe(0);
  });

  it('恢复段包含最近文件、工具与边界提示', () => {
    const recovery = new RecoveryState();
    for (let index = 0; index < 7; index++) recovery.recordFileRead(`/file-${index}`, `内容 ${index}`, index);
    const attachment = recovery.buildRecoveryAttachment(tools);
    expect(attachment).toContain('## 最近读过的文件');
    expect(attachment).toContain('/file/6'.replace('/file/', '/file-'));
    expect(attachment).not.toContain('/file-0\n');
    expect(attachment).toContain('read_file');
    expect(attachment).toContain('不要凭摘要或头部预览猜测');
  });
});
