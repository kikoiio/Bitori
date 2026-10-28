import {matchesGlob} from 'node:path';
import {z} from 'zod';
import {truncateUtf8} from '../limits.js';
import {interruptedResult, MAX_TEXT_BYTES, readLimitedUtf8, walkWorkspace, withTextBudget} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({query: z.string().min(1), filePattern: z.string().min(1).optional()}).strict();
type SearchTextArguments = {query: string; filePattern?: string | undefined};
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ENTRIES = 4096;
const MAX_LINE_BYTES = 4096;
export class SearchTextTool implements Tool<SearchTextArguments> {
  readonly name = 'search_text'; readonly description = '在工作区 UTF-8 文件中搜索普通文本；定位代码或内容前先用本工具查证，不要猜测位置'; readonly effect = 'read' as const;
  readonly inputSchema = z.toJSONSchema(schema, {io: 'input'});
  readonly strict = false;
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: SearchTextArguments, context: ToolContext): Promise<ToolExecutionResult> {
    try { return await withTextBudget(context.signal, async () => {
      const paths = await WorkspacePaths.create(context.workspaceRoot);
      const matches: Array<{path: string; line: number; column: number; text: string}> = [];
      const maxBytes = Math.max(0, Math.min(context.limits.maxResultBytes, MAX_TEXT_BYTES));
      const maxMatches = Math.max(0, Math.min(context.limits.maxMatches, 4096));
      let bytes = 0; let scanned = 0; let entries = 0; let skipped = 0; let observed = 0; let truncated = false;
      outer: for await (const entry of walkWorkspace(paths.root, context.signal, args.filePattern ?? '**/*')) {
        context.signal.throwIfAborted();
        if (++entries > MAX_ENTRIES || scanned >= MAX_SCAN_BYTES) { truncated = true; break; }
        if (entry.depthLimited) truncated = true;
        if (!entry.isFile || !matchesGlob(entry.path, args.filePattern ?? '**/*')) continue;
        const logical = entry.path;
        const path = await paths.existingFile(logical).catch(() => undefined);
        context.signal.throwIfAborted();
        if (!path) { skipped++; continue; }
        let result: Awaited<ReturnType<typeof readLimitedUtf8>>;
        try { result = await readLimitedUtf8(path, Math.min(MAX_FILE_BYTES, MAX_SCAN_BYTES - scanned), context.signal); }
        catch (error) { if (context.signal.aborted) throw error; skipped++; continue; }
        scanned += Math.min(result.fileBytes, MAX_FILE_BYTES, MAX_SCAN_BYTES - scanned);
        if (result.truncation.truncated) truncated = true;
        const lines = result.text.split(/\r?\n/);
        for (let line = 0; line < lines.length; line++) {
          context.signal.throwIfAborted();
          const text = lines[line]!; let from = 0;
          while (true) {
            const column = text.indexOf(args.query, from);
            if (column < 0) break;
            observed++;
            const excerpt = truncateUtf8(text, Math.min(MAX_LINE_BYTES, maxBytes));
            const match = {path: logical.replaceAll('\\', '/'), line: line + 1, column: column + 1, text: excerpt.text};
            const size = Buffer.byteLength(JSON.stringify(match)) + 1;
            if (matches.length >= maxMatches || bytes + size > maxBytes) { truncated = true; break outer; }
            matches.push(match); bytes += size;
            if (excerpt.truncation.truncated) truncated = true;
            from = column + args.query.length;
          }
        }
      }
      return {status: 'success', output: {matches, skippedFiles: skipped, countComplete: !truncated}, truncation: {truncated, originalUnits: observed, returnedUnits: matches.length, unit: 'matches'}};
    }); } catch (error) { return context.signal.aborted ? interruptedResult() : normalizeFileError(error); }
  }
}
