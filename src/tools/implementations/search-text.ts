import {glob, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import {z} from 'zod';
import {assertUtf8Text} from '../utf8.js';
import {WorkspacePaths} from '../workspace-paths.js';
import {normalizeFileError} from './shared.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({query: z.string().min(1), filePattern: z.string().min(1).optional()}).strict();
type SearchTextArguments = {query: string; filePattern?: string | undefined};
export class SearchTextTool implements Tool<SearchTextArguments> {
  // [s04] 与系统提示双重强化「路径先查证」规则。
  readonly name = 'search_text'; readonly description = '在工作区 UTF-8 文件中搜索普通文本；定位代码或内容前先用本工具查证，不要猜测位置'; readonly effect = 'read' as const;
  readonly inputSchema = {type: 'object', properties: {query: {type: 'string'}, filePattern: {type: 'string'}}, required: ['query'], additionalProperties: false};
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: SearchTextArguments, context: ToolContext): Promise<ToolExecutionResult> {
    try { const paths = await WorkspacePaths.create(context.workspaceRoot); const matches: Record<string, unknown>[] = []; let skipped = 0; let original = 0; for await (const entry of glob(args.filePattern ?? '**/*', {cwd: paths.root, withFileTypes: true, exclude: ['node_modules/**']})) { if (!entry.isFile()) continue; const logical = relative(paths.root, join(entry.parentPath, entry.name)); const path = await paths.existingFile(logical).catch(() => undefined); if (!path) { skipped++; continue; } let content: string; try { content = assertUtf8Text(await readFile(path)); } catch { skipped++; continue; } const lines = content.split(/\r?\n/); for (let line = 0; line < lines.length; line++) { let from = 0; while (true) { const column = lines[line]!.indexOf(args.query, from); if (column < 0) break; original++; if (matches.length < context.limits.maxMatches) matches.push({path: logical.replaceAll('\\', '/'), line: line + 1, column: column + 1, text: lines[line]}); from = column + Math.max(1, args.query.length); } } } return {status: 'success', output: {matches, skippedFiles: skipped}, truncation: {truncated: original > matches.length, originalUnits: original, returnedUnits: matches.length, unit: 'matches'}}; }
    catch (error) { return normalizeFileError(error); }
  }
}
