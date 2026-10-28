import {matchesGlob, relative} from 'node:path';
import {z} from 'zod';
import {interruptedResult, MAX_TEXT_BYTES, walkWorkspace, withTextBudget} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({pattern: z.string().min(1)}).strict();
export class FindFilesTool implements Tool<{pattern: string}> {
  readonly name = 'find_files'; readonly description = '使用 glob 模式查找工作区内的普通文件；确定文件路径前先用本工具查证，不要猜测'; readonly effect = 'read' as const;
  readonly inputSchema = z.toJSONSchema(schema, {io: 'input'});
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {pattern: string}, context: ToolContext): Promise<ToolExecutionResult> {
    try { return await withTextBudget(context.signal, async () => {
      const paths = await WorkspacePaths.create(context.workspaceRoot);
      const found: string[] = []; let bytes = 0; let entries = 0; let observed = 0; let truncated = false;
      const maxBytes = Math.max(0, Math.min(context.limits.maxResultBytes, MAX_TEXT_BYTES));
      const maxMatches = Math.max(0, Math.min(context.limits.maxMatches, 4096));
      for await (const entry of walkWorkspace(paths.root, context.signal, args.pattern)) {
        context.signal.throwIfAborted();
        if (++entries > 4096) { truncated = true; break; }
        if (entry.depthLimited) truncated = true;
        if (!entry.isFile || !matchesGlob(entry.path, args.pattern)) continue;
        const actual = await paths.existingFile(entry.path).catch(() => undefined);
        context.signal.throwIfAborted();
        if (!actual) continue;
        observed++;
        const name = relative(paths.root, actual).replaceAll('\\', '/');
        const size = Buffer.byteLength(JSON.stringify(name)) + 1;
        if (found.length >= maxMatches || bytes + size > maxBytes) { truncated = true; break; }
        found.push(name); bytes += size;
      }
      found.sort();
      return {status: 'success', output: {files: found, countComplete: !truncated}, truncation: {truncated, originalUnits: observed, returnedUnits: found.length, unit: 'matches'}};
    }); } catch (error) { return context.signal.aborted ? interruptedResult() : normalizeFileError(error); }
  }
}
