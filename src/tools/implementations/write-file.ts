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
  readonly inputSchema = z.toJSONSchema(schema, {io: 'input'});
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {path: string; content: string}, context: ToolContext): Promise<ToolExecutionResult> {
    let path: string | undefined; let created = false; let committed = false;
    try {
      context.signal.throwIfAborted();
      path = await (await WorkspacePaths.create(context.workspaceRoot)).newFile(args.path);
      context.signal.throwIfAborted();
      const handle = await this.operations.open(path, 'wx');
      created = true;
      try {
        await handle.writeFile(args.content, {encoding: 'utf8', signal: context.signal});
        // 同步是新文件的提交边界；开始后不再将成功提交伪报为取消。
        context.signal.throwIfAborted();
        await handle.sync();
        committed = true;
      } finally { await handle.close(); }
      return {status: 'success', output: {path: args.path, bytes: Buffer.byteLength(args.content)}};
    } catch (error) {
      if (created && !committed && path) await this.operations.unlink(path).catch(() => undefined);
      if (!committed && context.signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '文件写入已取消', retryable: false}};
      return normalizeFileError(error);
    }
  }
}
