import type {JsonObject, Tool, ToolContext, ToolEffect, ToolExecutionResult} from '../../src/tools/types.js';

/** [s02] 可控制延迟、异常和结果的工具替身。 */
export class MockTool implements Tool {
  readonly inputSchema = {type: 'object', additionalProperties: true};
  calls = 0;
  constructor(readonly name: string, readonly effect: ToolEffect = 'read', readonly behavior: (args: JsonObject, context: ToolContext) => Promise<ToolExecutionResult> = async () => ({status: 'success', output: {ok: true}})) {}
  readonly description = '测试工具';
  parseArguments(input: unknown): JsonObject { if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('参数必须是对象'); return input as JsonObject; }
  async execute(args: JsonObject, context: ToolContext): Promise<ToolExecutionResult> { this.calls++; return this.behavior(args, context); }
}
