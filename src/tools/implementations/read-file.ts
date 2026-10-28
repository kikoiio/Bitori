import {z} from 'zod';
import {relative} from 'node:path';
import {interruptedResult, MAX_TEXT_BYTES, readLimitedUtf8, withTextBudget} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({path: z.string().min(1)}).strict();
export class ReadFileTool implements Tool<{path: string}> {
  // 与系统提示双重强化「编辑前必先读取」规则。
  readonly name = 'read_file'; readonly description = '读取工作区内的 UTF-8 文本文件；编辑任何文件前必须先用本工具读取该文件'; readonly effect = 'read' as const;
  readonly inputSchema = {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false};
  parseArguments(input: unknown): {path: string} { return schema.parse(input); }
  async execute(args: {path: string}, context: ToolContext): Promise<ToolExecutionResult> {
    try { return await withTextBudget(context.signal, async () => { const paths = await WorkspacePaths.create(context.workspaceRoot); const path = await paths.existingFile(args.path); const result = await readLimitedUtf8(path, Math.min(context.limits.maxResultBytes, MAX_TEXT_BYTES), context.signal); return {status: 'success', output: {path: relative(paths.root, path), content: result.text, bytes: result.fileBytes}, truncation: result.truncation}; }); }
    catch (error) { return context.signal.aborted ? interruptedResult() : normalizeFileError(error); }
  }
}
