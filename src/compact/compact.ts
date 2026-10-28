import type {LLMClient, ModelContextItem} from '../providers/types.js';
import type {ToolDefinition} from '../tools/types.js';
import {CHARS_PER_TOKEN, estimateContextTokens, serializedItem} from '../shared/token-estimate.js';
import type {UsageAnchor} from '../shared/token-estimate.js';

export const SUMMARY_OUTPUT_RESERVE = 20_000;
export const AUTO_COMPACT_SAFETY_MARGIN = 13_000;
export const MANUAL_COMPACT_SAFETY_MARGIN = 3_000;
export const RECENT_TOKEN_FLOOR = 10_000;
export const RECENT_ITEM_FLOOR = 5;
export const MAX_AUTO_COMPACT_FAILURES = 3;

export interface CompactTrackingState {consecutiveFailures: number}
export interface ManageContextInput {
  items: readonly ModelContextItem[];
  client: LLMClient;
  contextWindow: number;
  tracking: CompactTrackingState;
  tools: readonly ToolDefinition[];
  anchor: UsageAnchor | null;
  signal: AbortSignal;
}
export type CompactResult =
  | {compacted: true; beforeTokens: number; afterTokens: number; summary: string; items: ModelContextItem[]; checkpointItems: ModelContextItem[]; keepIndex: number; reason: 'auto' | 'manual'}
  | {compacted: false; beforeTokens: number; afterTokens: number; summary: null; reason: 'below_threshold' | 'circuit_open' | 'too_few_messages'};

/** 找到被摘要覆盖部分的最后一条可重放消息，避免检查点错误地指向保留尾部。 */
export function compactionBoundaryMessageId(items: readonly ModelContextItem[], keepIndex: number): string {
  for (let index = Math.min(keepIndex - 1, items.length - 1); index >= 0; index--) {
    const item = items[index];
    if ((item?.type === 'message' || item?.type === 'assistant_iteration') && item.messageId !== 'compact-summary') return item.messageId;
  }
  throw new Error('压缩检查点缺少历史边界');
}

function promptFor(items: readonly ModelContextItem[]): string {
  const dialogue = items.map(item => {
    if (item.type === 'message') return `${item.role}: ${item.content}`;
    if (item.type === 'reminder') return `system: ${item.text}`;
    if (item.type === 'assistant_iteration') return `assistant: ${item.content}${item.toolCalls.length > 0 ? `\n工具调用: ${JSON.stringify(item.toolCalls)}` : ''}`;
    return `tool_results: ${JSON.stringify(item.results)}`;
  }).join('\n\n');
  return [
    '请压缩以下对话。不要调用任何工具。先在 <analysis> 中写分析草稿，再在 <summary> 中输出正式摘要；草稿会被丢弃。',
    '正式摘要包含 9 个小节：1 用户目标；2 已完成工作；3 关键决策；4 未解决问题；5 相关文件；6 用户消息原文；7 工具调用纪要；8 风险与约束；9 下一步建议。',
    dialogue,
  ].join('\n\n');
}

function parseSummary(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  return (match?.[1] ?? text).trim();
}

export function computeKeepStartIndex(items: readonly ModelContextItem[]): number {
  let tokens = 0;
  let index = items.length;
  while (index > 0 && (items.length - index < RECENT_ITEM_FLOOR || tokens < RECENT_TOKEN_FLOOR)) {
    index--;
    tokens += Math.ceil(Buffer.byteLength(serializedItem(items[index]!), 'utf8') / CHARS_PER_TOKEN);
  }
  const first = items[index];
  if (first?.type === 'tool_results' && index > 0) {
    const previous = items[index - 1];
    if (previous?.type === 'assistant_iteration' && previous.messageId === first.assistantMessageId) index--;
  }
  return index;
}

async function summarize(input: ManageContextInput, items: readonly ModelContextItem[]): Promise<string> {
  const prompt = promptFor(items);
  const stream = input.client.streamChat({messages: [{role: 'user', content: prompt}], items: [{type: 'message', messageId: 'compact-summary', role: 'user', content: prompt}]}, input.signal);
  let text = ''; let completed = false;
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'error') throw new Error(event.error.message);
    if (event.type === 'completed' && event.finishReason !== 'cancelled') completed = true;
  }
  if (input.signal.aborted || !completed || !parseSummary(text)) throw new Error('摘要未正常完成');
  return parseSummary(text);
}

/** 自动与手动共用摘要路径；自动路径受阈值与熔断约束，手动路径只要求有可压缩消息。 */
export async function manageContext(input: ManageContextInput, options: {force?: boolean; safetyMargin?: number} = {}): Promise<CompactResult> {
  const before = estimateContextTokens(input.items, input.anchor);
  const margin = options.safetyMargin ?? AUTO_COMPACT_SAFETY_MARGIN;
  if (!options.force && before < input.contextWindow - margin) return {compacted: false, beforeTokens: before, afterTokens: before, summary: null, reason: 'below_threshold'};
  if (!options.force && input.tracking.consecutiveFailures >= MAX_AUTO_COMPACT_FAILURES) return {compacted: false, beforeTokens: before, afterTokens: before, summary: null, reason: 'circuit_open'};
  const keepStart = computeKeepStartIndex(input.items);
  if (keepStart < 1) return {compacted: false, beforeTokens: before, afterTokens: before, summary: null, reason: 'too_few_messages'};
  try {
    const summary = await summarize(input, input.items.slice(0, keepStart));
    input.tracking.consecutiveFailures = 0;
    const attachment = [
      '## 当前可用工具', ...input.tools.map(tool => `- ${tool.name}: ${tool.description}`), '',
      '## 边界提示',
      '以上内容是压缩后的恢复信息。需要文件、工具输出或代码细节时请重新读取原文，不要凭摘要或头部预览猜测。',
    ].join('\n');
    const checkpointItems: ModelContextItem[] = [
      {type: 'message', messageId: 'compact-summary', role: 'user', content: `${summary}\n\n${attachment}`},
    ];
    const compacted = [...checkpointItems, ...input.items.slice(keepStart)];
    return {compacted: true, beforeTokens: before, afterTokens: estimateContextTokens(compacted, null), summary, items: compacted, checkpointItems, keepIndex: keepStart, reason: options.force ? 'manual' : 'auto'};
  } catch {
    if (!input.signal.aborted) input.tracking.consecutiveFailures++;
    throw new Error('上下文压缩失败');
  }
}
