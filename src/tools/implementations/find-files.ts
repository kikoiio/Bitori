import {glob} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {z} from 'zod';
import {limitMatches} from '../limits.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({pattern: z.string().min(1)}).strict();
export class FindFilesTool implements Tool<{pattern: string}> {
  // 与系统提示双重强化「路径先查证」规则。
  readonly name = 'find_files'; readonly description = '使用 glob 模式查找工作区内的普通文件；确定文件路径前先用本工具查证，不要猜测'; readonly effect = 'read' as const;
  readonly inputSchema = {type: 'object', properties: {pattern: {type: 'string'}}, required: ['pattern'], additionalProperties: false};
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {pattern: string}, context: ToolContext): Promise<ToolExecutionResult> {
    try { const paths = await WorkspacePaths.create(context.workspaceRoot); const found: string[] = []; for await (const path of glob(args.pattern, {cwd: paths.root, withFileTypes: true, exclude: ['node_modules/**']})) { if (!path.isFile()) continue; const actual = await paths.existingFile(relative(paths.root, join(path.parentPath, path.name))).catch(() => undefined); if (actual) found.push(relative(paths.root, actual).replaceAll('\\', '/')); } found.sort(); const limited = limitMatches(found, context.limits.maxMatches); return {status: 'success', output: {files: limited.matches}, truncation: limited.truncation}; }
    catch (error) { return normalizeFileError(error); }
  }
}
