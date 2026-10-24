import {z} from 'zod';
import type {LLMClient} from '../../providers/types.js';
import type {AgentDefinition} from '../../subagents/types.js';
import {spawnSubAgent} from '../../subagents/spawn.js';
import {filterToolsForAgent} from '../../subagents/tool-filter.js';
import type {JsonObject, Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({
  agent: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  context: z.string().optional(),
}).strict();

/** [s12] 把 SubAgent 派发暴露为模型可用工具；内置角色和用户自定义角色共用同一入口。 */
export class AgentTool implements Tool<z.infer<typeof schema>> {
  readonly name = 'agent';
  readonly description = '派出一个子 Agent 处理独立子任务并返回最终文本；适合研究、探索和规划，不适合直接询问当前用户';
  readonly effect = 'read' as const;
  readonly inputSchema: JsonObject = {
    type: 'object',
    properties: {
      agent: {type: 'string', description: 'SubAgent 名称'},
      prompt: {type: 'string', description: '给子 Agent 的完整任务说明'},
    },
    required: ['agent', 'prompt'],
    additionalProperties: false,
  };

  constructor(
    private readonly definitions: readonly AgentDefinition[],
    private readonly clientFor: (model: string | null) => LLMClient,
  ) {}

  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: z.infer<typeof schema>, context: ToolContext): Promise<ToolExecutionResult> {
    const definition = this.definitions.find(item => item.name === args.agent);
    if (!definition) {
      const names = this.definitions.map(item => item.name).join(', ');
      return {status: 'error', error: {code: 'unknown_tool', message: `SubAgent 不存在：${args.agent}。可用：${names}`, retryable: false}};
    }
    try {
      const output = await spawnSubAgent({
        client: this.clientFor(definition.model ?? null),
        definition,
        prompt: args.prompt,
        signal: context.signal,
      });
      const availableTools = filterToolsForAgent([], definition).length;
      return {status: 'success', output: {agent: definition.name, output, toolCount: availableTools}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
