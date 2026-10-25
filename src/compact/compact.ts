import type {LLMClient, ModelContextItem} from '../providers/types.js';
import type {RecoveryState} from './recovery.js';
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
  recovery: RecoveryState;
  tools: readonly ToolDefinition[];
  anchor: UsageAnchor | null;
  signal: AbortSignal;
}
export interface CompactResult {compacted: boolean; beforeTokens: number; afterTokens: number; summary: string | null; reason: 'auto' | 'manual' | 'below_threshold' | 'circuit_open' | 'too_few_messages'}

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
  const boundary = Math.max(0, items.length - RECENT_ITEM_FLOOR);
  for (let i = items.length - 1; i >= boundary; i--) {
    tokens += Math.ceil(Buffer.byteLength(serializedItem(items[i]!), 'utf8') / CHARS_PER_TOKEN);
    index = i;
    if (tokens >= RECENT_TOKEN_FLOOR) break;
  }
  return Math.min(index, Math.max(0, items.length - RECENT_ITEM_FLOOR));
}

async function summarize(input: ManageContextInput, items: readonly ModelContextItem[]): Promise<string> {
  const stream = input.client.streamChat({messages: [{role: 'user', content: promptFor(items)}], items: [{type: 'message', messageId: 'compact-summary', role: 'user', content: promptFor(items)}]}, input.signal);
  let text = '';
  for await (const event of stream) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'error') throw new Error(event.error.message);
  }
  return parseSummary(text);
}

/** [s07] 自动与手动共用摘要路径；自动路径受阈值与熔断约束，手动路径只要求有可压缩消息。 */
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
    const attachment = input.recovery.buildRecoveryAttachment(input.tools);
    const compacted: ModelContextItem[] = [
      {type: 'message', messageId: 'compact-summary', role: 'user', content: `${summary}\n\n${attachment}`},
      ...input.items.slice(keepStart),
    ];
    return {compacted: true, beforeTokens: before, afterTokens: estimateContextTokens(compacted, null), summary, reason: options.force ? 'manual' : 'auto'};
  } catch {
    input.tracking.consecutiveFailures++;
    throw new Error('上下文压缩失败');
  }
}
