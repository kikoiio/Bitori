import {open, rename, unlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assertUtf8Text} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError, toolError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';
import {readFile} from 'node:fs/promises';

const schema = z.object({path: z.string().min(1), oldText: z.string().min(1), newText: z.string()}).strict();
export class EditFileTool implements Tool<{path: string; oldText: string; newText: string}> {
  constructor(private readonly operations: {open: typeof open; rename: typeof rename; unlink: typeof unlink} = {open, rename, unlink}) {}
  /* [s02 旧实现，s04 替换] readonly description = '对工作区现有 UTF-8 文件执行唯一字面匹配替换' */
  // [s04] 与系统提示双重强化「编辑前必先读取」规则。
  readonly name = 'edit_file'; readonly description = '对工作区现有 UTF-8 文件执行唯一字面匹配替换；编辑前必须先用 read_file 读取该文件，不得凭记忆或猜测修改'; readonly effect = 'write' as const;
  readonly inputSchema = {type: 'object', properties: {path: {type: 'string'}, oldText: {type: 'string'}, newText: {type: 'string'}}, required: ['path', 'oldText', 'newText'], additionalProperties: false};
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {path: string; oldText: string; newText: string}, context: ToolContext): Promise<ToolExecutionResult> {
    let temporary: string | undefined;
    try { const path = await (await WorkspacePaths.create(context.workspaceRoot)).existingFile(args.path); const content = assertUtf8Text(await readFile(path)); const pieces = content.split(args.oldText); if (pieces.length !== 2) return toolError('no_unique_match', `待替换文本匹配了 ${pieces.length - 1} 次，必须恰好一次`); const updated = pieces[0] + args.newText + pieces[1]; temporary = join(dirname(path), `.bitori-${randomUUID()}.tmp`); const handle = await this.operations.open(temporary, 'wx'); try { await handle.writeFile(updated, 'utf8'); await handle.sync(); } finally { await handle.close(); } await this.operations.rename(temporary, path); temporary = undefined; return {status: 'success', output: {path: args.path, replacements: 1}}; }
    catch (error) { return normalizeFileError(error); }
    finally { if (temporary) await this.operations.unlink(temporary).catch(() => undefined); }
  }
}
