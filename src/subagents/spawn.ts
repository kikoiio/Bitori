import type {LLMClient, ModelContextItem, StreamEvent} from '../providers/types.js';
import type {AgentDefinition} from './types.js';

export type AgentEventSink = (event: StreamEvent) => void;

export interface SpawnSubAgentInput {
  client: LLMClient;
  definition: AgentDefinition;
  prompt: string;
  context?: readonly ModelContextItem[];
  signal?: globalThis.AbortSignal;
  onEvent?: AgentEventSink;
}

/** 子 Agent 非交互执行，不调用工具，只收集最终文本。 */
export async function spawnSubAgent(input: SpawnSubAgentInput): Promise<string> {
  if (input.definition.unsupportedFields?.length) throw new Error(`文本咨询不支持配置：${input.definition.unsupportedFields.join(', ')}`);
  const system = input.definition.systemPromptOverride ?? input.definition.initialPrompt;
  const content = ['You have no tools or workspace access. Use only supplied context; do not claim to have searched, inspected, or changed files.', system, input.prompt].filter(Boolean).join('\n\n');
  const items: ModelContextItem[] = [...(input.context ?? []), {type: 'message', messageId: 'subagent-prompt', role: 'user', content}];
  const stream = input.client.streamChat({messages: [{role: 'user', content}], items}, input.signal ?? new AbortController().signal);
  let output = '';
  for await (const event of stream) {
    input.onEvent?.(event);
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error.message);
  }
  return output;
}
