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

/** [s12] 子 Agent 非交互跑到底：不执行工具调用，只收集最终文本；工具执行接入调度器后复用此循环。 */
export async function spawnSubAgent(input: SpawnSubAgentInput): Promise<string> {
  const system = input.definition.systemPromptOverride ?? input.definition.initialPrompt;
  const content = [system, input.prompt].filter(Boolean).join('\n\n');
  const items: ModelContextItem[] = input.context ? [...input.context] : [{type: 'message', messageId: 'subagent-prompt', role: 'user', content}];
  const stream = input.client.streamChat({messages: [{role: 'user', content}], items, ...(input.context ? {} : {})}, input.signal ?? new AbortController().signal);
  let output = '';
  for await (const event of stream) {
    input.onEvent?.(event);
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error.message);
  }
  return output;
}
