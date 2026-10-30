import type {ToolCallRecord} from '../storage/types.js';
import type {JsonObject, ToolExecutionResult} from '../tools/types.js';
import {countDiff, diffLines, formatDiffSummary} from './diff.js';

export type CollapseClass = 'read' | 'search' | 'glob';

export type ToolDisplayItem =
  | {kind: 'call'; record: ToolCallRecord}
  | {kind: 'summary'; collapseClass: CollapseClass; count: number};

const DISPLAY_NAMES: Record<string, string> = {
  read_file: 'Read',
  edit_file: 'Update',
  write_file: 'Write',
  run_command: 'Bash',
  search_text: 'Search',
  find_files: 'Glob',
  agent: 'Agent',
};

const RUNNING_VERBS: Record<string, string> = {
  read_file: 'Reading',
  edit_file: 'Updating',
  write_file: 'Writing',
  run_command: 'Running',
  search_text: 'Searching',
  find_files: 'Finding',
  agent: 'Consulting',
};

const COLLAPSE_CLASS: Record<string, CollapseClass> = {
  read_file: 'read',
  search_text: 'search',
  find_files: 'glob',
};

const PRIMARY_KEYS = ['path', 'command', 'query', 'pattern', 'agent', 'file', 'filename'] as const;
const HEADLINE_ARG_LIMIT = 48;
const RESULT_LINE_LIMIT = 80;

export function displayName(toolName: string): string {
  return DISPLAY_NAMES[toolName] ?? toolName;
}

export function primaryArgument(toolName: string, args: JsonObject): string | null {
  for (const key of PRIMARY_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return compactArgument(value, toolName === 'run_command');
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim().length > 0) return compactArgument(value, false);
  }
  return null;
}

export function foldToolCalls(records: readonly ToolCallRecord[], verbose: boolean): ToolDisplayItem[] {
  if (verbose) return records.map(record => ({kind: 'call' as const, record}));
  const items: ToolDisplayItem[] = [];
  let index = 0;
  while (index < records.length) {
    const current = records[index]!;
    const collapseClass = collapsibleClass(current);
    if (collapseClass === null) {
      items.push({kind: 'call', record: current});
      index += 1;
      continue;
    }
    let count = 0;
    while (index < records.length && collapsibleClass(records[index]!) === collapseClass) {
      count += 1;
      index += 1;
    }
    items.push({kind: 'summary', collapseClass, count});
  }
  return items;
}

export function collapseLabel(collapseClass: CollapseClass, count: number): string {
  if (collapseClass === 'read') return `读取 ${count} 个文件`;
  if (collapseClass === 'search') return `搜索 ${count} 次`;
  return `查找 ${count} 个文件`;
}

export function callHeadline(record: ToolCallRecord): string {
  const argument = primaryArgument(record.toolName, record.arguments);
  if (record.executionStatus === 'running' || record.executionStatus === 'queued') {
    const verb = RUNNING_VERBS[record.toolName] ?? displayName(record.toolName);
    return argument === null ? `${verb}…` : `${verb} ${argument}`;
  }
  const name = displayName(record.toolName);
  return argument === null ? name : `${name}(${argument})`;
}

export function resultLine(record: ToolCallRecord, verbose: boolean): string | null {
  if (record.executionStatus === 'running' || record.executionStatus === 'queued') return null;
  if (record.executionStatus === 'skipped') return '已跳过';
  if (record.executionStatus === 'interrupted') return interruptedMessage(record);
  if (record.executionStatus === 'timed_out') return timeoutMessage(record);
  if (record.executionStatus === 'failed') return errorMessage(record) ?? '失败';
  return successLine(record, verbose);
}

export function editHunk(args: JsonObject): {oldText: string; newText: string} | null {
  const oldText = args.oldText;
  const newText = args.newText;
  if (typeof oldText === 'string' && typeof newText === 'string') return {oldText, newText};
  const content = args.content;
  if (typeof content === 'string') return {oldText: '', newText: content};
  return null;
}

export function sessionHunks(records: readonly ToolCallRecord[]): Array<{path: string; oldText: string; newText: string}> {
  const hunks: Array<{path: string; oldText: string; newText: string}> = [];
  for (const record of records) {
    if (record.executionStatus !== 'succeeded') continue;
    if (record.toolName !== 'edit_file' && record.toolName !== 'write_file') continue;
    const path = typeof record.arguments.path === 'string' ? record.arguments.path : null;
    const hunk = editHunk(record.arguments);
    if (path === null || hunk === null) continue;
    hunks.push({path, ...hunk});
  }
  return hunks;
}

function collapsibleClass(record: ToolCallRecord): CollapseClass | null {
  if (record.executionStatus !== 'succeeded') return null;
  return COLLAPSE_CLASS[record.toolName] ?? null;
}

function compactArgument(value: string, command: boolean): string {
  const first = command ? value.trim().split(/\s*\n/)[0] ?? value : value.trim();
  const basename = !command && (first.includes('/') || first.includes('\\')) ? first.replace(/^.*[/\\]/, '') : first;
  if (basename.length <= HEADLINE_ARG_LIMIT) return basename;
  return `${basename.slice(0, HEADLINE_ARG_LIMIT - 1)}…`;
}

function successLine(record: ToolCallRecord, verbose: boolean): string {
  const hunk = record.toolName === 'edit_file' || record.toolName === 'write_file' ? editHunk(record.arguments) : null;
  if (hunk !== null) {
    const counts = countDiff(diffLines(hunk.oldText, hunk.newText));
    return formatDiffSummary(counts.added, counts.removed);
  }
  if (record.toolName === 'run_command') return commandOutput(record.result, verbose);
  if (record.toolName === 'read_file') return readOutput(record.result, verbose);
  if (record.toolName === 'search_text') return searchOutput(record.result);
  if (record.toolName === 'find_files') return globOutput(record.result);
  if (record.toolName === 'agent') return agentOutput(record.result, verbose);
  return genericOutput(record.result, verbose);
}

function commandOutput(result: ToolExecutionResult | null, verbose: boolean): string {
  const payload = resultPayload(result);
  const stdout = stringify(payload?.stdout).trim();
  const stderr = stringify(payload?.stderr).trim();
  const text = stdout.length > 0 ? stdout : stderr;
  if (text.length === 0) return '(无输出)';
  return clipPreview(text, verbose);
}

function readOutput(result: ToolExecutionResult | null, verbose: boolean): string {
  const payload = resultPayload(result);
  const content = stringify(payload?.content);
  if (!verbose) {
    const lines = content.length === 0 ? 0 : content.split('\n').length;
    return `读取 ${lines} 行`;
  }
  return clipPreview(content, true);
}

function searchOutput(result: ToolExecutionResult | null): string {
  const payload = resultPayload(result);
  const matches = payload?.matches;
  const count = Array.isArray(matches) ? matches.length : 0;
  return `${count} 处匹配`;
}

function globOutput(result: ToolExecutionResult | null): string {
  const payload = resultPayload(result);
  const files = payload?.files;
  const count = Array.isArray(files) ? files.length : 0;
  return `${count} 个文件`;
}

function agentOutput(result: ToolExecutionResult | null, verbose: boolean): string {
  const payload = resultPayload(result);
  const output = stringify(payload?.output);
  if (output.length === 0) return '(无输出)';
  return clipPreview(output, verbose);
}

function genericOutput(result: ToolExecutionResult | null, verbose: boolean): string {
  if (result === null) return '(无输出)';
  if (result.status !== 'success') return result.error.message;
  try {
    return clipPreview(JSON.stringify(result.output), verbose);
  } catch {
    return '(无输出)';
  }
}

function errorMessage(record: ToolCallRecord): string | null {
  const result = record.result;
  if (result !== null && result.status !== 'success') return result.error.message;
  return null;
}

function interruptedMessage(record: ToolCallRecord): string {
  return errorMessage(record) ?? '已取消';
}

function timeoutMessage(record: ToolCallRecord): string {
  return errorMessage(record) ?? '超时';
}

function resultPayload(result: ToolExecutionResult | null): JsonObject | undefined {
  if (result === null) return undefined;
  if (result.status === 'success') return result.output;
  return result.partialOutput;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clipPreview(text: string, verbose: boolean): string {
  const lines = text.split('\n');
  if (!verbose) {
    const first = lines.find(line => line.trim().length > 0) ?? lines[0] ?? '';
    return first.length <= RESULT_LINE_LIMIT ? first : `${first.slice(0, RESULT_LINE_LIMIT - 1)}…`;
  }
  const kept = lines.slice(0, 12).join('\n');
  return lines.length > 12 ? `${kept}\n…` : kept;
}
