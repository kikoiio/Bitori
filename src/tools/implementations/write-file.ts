import {open, unlink} from 'node:fs/promises';
import {z} from 'zod';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({path: z.string().min(1), content: z.string()}).strict();
export class WriteFileTool implements Tool<{path: string; content: string}> {
  constructor(private readonly operations: {open: typeof open; unlink: typeof unlink} = {open, unlink}) {}
  // 与系统提示双重强化「编辑前必先读取」规则。
  readonly name = 'write_file'; readonly description = '在工作区内排他创建新的 UTF-8 文本文件；用于新建文件，修改已有文件应先用 read_file 读取再用 edit_file 局部修改'; readonly effect = 'write' as const;
  readonly inputSchema = {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content'], additionalProperties: false};
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {path: string; content: string}, context: ToolContext): Promise<ToolExecutionResult> {
    let path: string | undefined; let created = false;
    try { path = await (await WorkspacePaths.create(context.workspaceRoot)).newFile(args.path); const handle = await this.operations.open(path, 'wx'); created = true; try { await handle.writeFile(args.content, 'utf8'); await handle.sync(); } finally { await handle.close(); } return {status: 'success', output: {path: args.path, bytes: Buffer.byteLength(args.content)}}; }
    catch (error) { if (created && path) await this.operations.unlink(path).catch(() => undefined); return normalizeFileError(error); }
  }
}
