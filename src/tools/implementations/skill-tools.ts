import {z} from 'zod';
import type {SkillLoader} from '../../skills/loader.js';
import type {SkillExecutor} from '../../skills/executor.js';
import type {JsonObject, Tool, ToolExecutionResult} from '../types.js';

const schema = z.object({name: z.string().trim().min(1)}).strict();

/** 两阶段加载的第二阶段：模型按需读取 Skill 正文并激活到环境上下文。 */
export class LoadSkillTool implements Tool<{name: string}> {
  readonly name = 'load_skill';
  readonly description = '加载一个已注册 Skill 的完整 SOP；输入 Skill 名称，成功后该技能将在后续对话中保持激活';
  readonly effect = 'read' as const;
  readonly inputSchema: JsonObject = {type: 'object', properties: {name: {type: 'string'}}, required: ['name'], additionalProperties: false};

  constructor(private readonly loader: SkillLoader, private readonly executor: SkillExecutor) {}

  parseArguments(input: unknown) { return schema.parse(input); }
  execute(args: {name: string}): Promise<ToolExecutionResult> { return Promise.resolve(this.#run(args)); }

  #run(args: {name: string}): ToolExecutionResult {
    const skill = this.loader.getFresh(args.name);
    if (!skill) {
      const names = this.loader.names().join(', ') || '（无可用 Skill）';
      return {status: 'error', error: {code: 'path_not_found', message: `Skill 不存在：${args.name}。可用：${names}`, retryable: false}};
    }
    const body = this.executor.executeInline(skill, '');
    return {status: 'success', output: {name: skill.meta.name, body}};
  }
}
