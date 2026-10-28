import {open, readFile, rename, stat, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertUtf8Text} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError, toolError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({path: z.string().min(1), oldText: z.string().min(1), newText: z.string()}).strict();
export class EditFileTool implements Tool<{path: string; oldText: string; newText: string}> {
  constructor(private readonly operations: {open: typeof open; rename: typeof rename; unlink: typeof unlink} = {open, rename, unlink}) {}
  // 与系统提示双重强化「编辑前必先读取」规则。
  readonly name = 'edit_file'; readonly description = '对工作区现有 UTF-8 文件执行唯一字面匹配替换；编辑前必须先用 read_file 读取该文件，不得凭记忆或猜测修改'; readonly effect = 'write' as const;
  readonly inputSchema = z.toJSONSchema(schema, {io: 'input'});
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {path: string; oldText: string; newText: string}, context: ToolContext): Promise<ToolExecutionResult> {
    let temporary: string | undefined;
    try {
      context.signal.throwIfAborted();
      const path = await (await WorkspacePaths.create(context.workspaceRoot)).existingFile(args.path);
      const mode = (await stat(path)).mode & 0o7777;
      const content = assertUtf8Text(await readFile(path, {signal: context.signal}));
      const pieces = content.split(args.oldText);
      if (pieces.length !== 2) return toolError('no_unique_match', `待替换文本匹配了 ${pieces.length - 1} 次，必须恰好一次`);
      const updated = pieces[0] + args.newText + pieces[1];
      const candidate = join(dirname(path), `.bitori-${randomUUID()}.tmp`);
      context.signal.throwIfAborted();
      const handle = await this.operations.open(candidate, 'wx', 0o600);
      // 排他创建成功后才拥有临时文件，避免清理其他调用的文件。
      temporary = candidate;
      try {
        await handle.writeFile(updated, {encoding: 'utf8', signal: context.signal});
        await handle.chmod(mode);
        await handle.sync();
      } finally { await handle.close(); }
      // rename 是原子提交点，提交成功后即使收到取消也保留成功结果。
      context.signal.throwIfAborted();
      await this.operations.rename(temporary, path);
      temporary = undefined;
      return {status: 'success', output: {path: args.path, replacements: 1}};
    } catch (error) {
      if (context.signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '文件编辑已取消', retryable: false}};
      return normalizeFileError(error);
    }
    finally { if (temporary) await this.operations.unlink(temporary).catch(() => undefined); }
  }
}
