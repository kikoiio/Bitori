import type {ModelContextItem} from '../providers/types.js';
import type {PromptBlock} from '../prompt/builder.js';
import {estimateTextTokens, serializedItem} from '../shared/token-estimate.js';
import type {ToolDefinition} from '../tools/types.js';
import {emptyCompositionBuckets, type ContextCompositionBuckets} from './types.js';

export interface CompositionInput {
  items: readonly ModelContextItem[];
  system: readonly PromptBlock[];
  toolDefinitions: readonly ToolDefinition[];
}

/** [s15] 逐桶估算一次请求的上下文组成；估算与真实 input tokens 的差值由调用方附加。 */
export function composeBuckets(input: CompositionInput): ContextCompositionBuckets {
  const buckets = emptyCompositionBuckets();
  for (const block of input.system) {
    const tokens = estimateTextTokens(block.text);
    const id = block.sectionId ?? 'fixed_system';
    if (id === 'fixed_system') buckets.fixed_system += tokens;
    else if (id === 'environment') buckets.environment += tokens;
    else if (id === 'customInstructions') buckets.custom_instructions += tokens;
    else if (id === 'skills') buckets.skills += tokens;
    else if (id === 'longTermMemory') buckets.long_term_memory += tokens;
    else buckets.custom_instructions += tokens;
  }
  buckets.tool_definitions += input.toolDefinitions.reduce((sum, definition) => sum + estimateTextTokens(JSON.stringify(definition)), 0);
  for (const item of input.items) {
    const tokens = estimateTextTokens(serializedItem(item));
    if (item.type === 'message') {
      if (item.messageId === 'compact-summary') buckets.compact_summary += tokens;
      else if (item.role === 'user') buckets.user_messages += tokens;
      else buckets.assistant_messages += tokens;
    } else if (item.type === 'reminder') buckets.reminders += tokens;
    else if (item.type === 'assistant_iteration') buckets.assistant_messages += tokens;
    else buckets.tool_results += tokens;
  }
  return buckets;
}

const BUCKET_KEYS = ['fixed_system', 'environment', 'custom_instructions', 'skills', 'long_term_memory', 'tool_definitions', 'user_messages', 'assistant_messages', 'tool_results', 'reminders', 'compact_summary'] as const;

export function compositionTotal(buckets: ContextCompositionBuckets): number {
  return BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0);
}
