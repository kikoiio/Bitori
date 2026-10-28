import {z} from 'zod';
import type {LLMClient} from '../../providers/types.js';
import type {AgentDefinition} from '../../subagents/types.js';
import {spawnSubAgent} from '../../subagents/spawn.js';
import type {JsonObject, Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({
  agent: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  context: z.string().optional(),
}).strict();

/** 把 SubAgent 派发暴露为模型可用工具；内置角色和用户自定义角色共用同一入口。 */
export class AgentTool implements Tool<z.infer<typeof schema>> {
  readonly name = 'agent';
  readonly description = '进行一次文本咨询：仅依据提供的内容回答，不具备工具、文件或工作区访问能力';
  readonly effect = 'read' as const;
  readonly inputSchema: JsonObject = {
    type: 'object',
    properties: {
      agent: {type: 'string', description: 'SubAgent 名称'},
      prompt: {type: 'string', description: '给子 Agent 的完整任务说明'},
      context: {type: 'string', description: '供咨询使用的背景材料'},
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
    if (definition.unsupportedFields?.length) {
      return {status: 'error', error: {code: 'tool_unavailable_in_mode', message: '文本咨询不支持工具、权限模式、轮次或后台配置', retryable: false}};
    }
    try {
      const output = await spawnSubAgent({
        client: this.clientFor(definition.model ?? null),
        definition,
        prompt: args.context ? `背景材料：\n${args.context}\n\n任务：\n${args.prompt}` : args.prompt,
        signal: context.signal,
      });
      return {status: 'success', output: {agent: definition.name, output, toolCount: 0}};
    } catch (error) {
      return {status: 'error', error: {code: 'internal_error', message: error instanceof Error ? error.message : String(error), retryable: false}};
    }
  }
}
