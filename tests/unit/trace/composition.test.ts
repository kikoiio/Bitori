import {describe, expect, it} from 'vitest';
import {composeBuckets, compositionTotal} from '../../../src/trace/composition.js';
import type {ModelContextItem} from '../../../src/providers/types.js';
import type {PromptBlock} from '../../../src/prompt/builder.js';
import type {ToolDefinition} from '../../../src/tools/types.js';

function systemBlocks(): PromptBlock[] {
  return [
    {text: '固定系统提示'.repeat(20), cacheable: true, sectionId: 'fixed_system'},
    {text: '工作目录 /home/demo', cacheable: false, sectionId: 'environment'},
    {text: '自定义指令'.repeat(10), cacheable: false, sectionId: 'customInstructions'},
    {text: 'Available skills: demo', cacheable: false, sectionId: 'skills'},
  ];
}

const toolDefinitions: ToolDefinition[] = [{name: 'read_file', description: '读取文件内容'.repeat(5), effect: 'read', inputSchema: {type: 'object'}}] as unknown as ToolDefinition[];

describe('composeBuckets', () => {
  it('系统块按 sectionId 入桶', () => {
    const buckets = composeBuckets({items: [], system: systemBlocks(), toolDefinitions: []});
    expect(buckets.fixed_system).toBeGreaterThan(0);
    expect(buckets.environment).toBeGreaterThan(0);
    expect(buckets.custom_instructions).toBeGreaterThan(0);
    expect(buckets.skills).toBeGreaterThan(0);
    expect(buckets.fixed_system).toBeGreaterThan(buckets.environment);
  });

  it('消息、工具结果、提醒与压缩摘要各入其桶', () => {
    const items: ModelContextItem[] = [
      {type: 'message', messageId: 'm1', role: 'user', content: '帮我修复测试'},
      {type: 'message', messageId: 'm2', role: 'assistant', content: '好的'},
      {type: 'assistant_iteration', messageId: 'it1', content: '查看文件', thinking: '', toolCalls: []},
      {type: 'tool_results', assistantMessageId: 'it1', results: []},
      {type: 'reminder', text: '当前处于 PLAN 模式'},
      {type: 'message', messageId: 'compact-summary', role: 'user', content: '历史摘要'},
    ];
    const buckets = composeBuckets({items, system: [], toolDefinitions: []});
    expect(buckets.user_messages).toBeGreaterThan(0);
    expect(buckets.assistant_messages).toBeGreaterThan(0);
    expect(buckets.tool_results).toBeGreaterThan(0);
    expect(buckets.reminders).toBeGreaterThan(0);
    expect(buckets.compact_summary).toBeGreaterThan(0);
    // 空工具结果仍有 JSON 结构开销，但不等于零桶。
    expect(compositionTotal(buckets)).toBe(buckets.user_messages + buckets.assistant_messages + buckets.tool_results + buckets.reminders + buckets.compact_summary);
  });

  it('工具定义计入独立桶', () => {
    const buckets = composeBuckets({items: [], system: [], toolDefinitions});
    expect(buckets.tool_definitions).toBeGreaterThan(0);
  });

  it('中英文混合样本的估算随 CJK 密度增加而更贵', () => {
    const ascii = composeBuckets({items: [], system: [{text: 'a'.repeat(350), cacheable: false, sectionId: 'environment'}], toolDefinitions: []});
    const cjk = composeBuckets({items: [], system: [{text: '字'.repeat(175), cacheable: false, sectionId: 'environment'}], toolDefinitions: []});
    // 同等字节量下 CJK 更接近 1 字符/token，估算显著高于 ASCII 的 3.5 字符/token。
    expect(cjk.environment).toBeGreaterThan(ascii.environment);
    expect(ascii.environment).toBe(100);
  });
});
