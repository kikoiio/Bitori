import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ModelContextItem, ModelToolResultsItem} from '../providers/types.js';
import type {ToolResultReplacementState} from './state.js';

export const SINGLE_RESULT_LIMIT = 50_000;
export const MESSAGE_AGGREGATE_LIMIT = 200_000;
export const OLD_RESULT_SNIP_BYTES = 2_000;
export const KEEP_RECENT_TURNS = 10;
export const PREVIEW_BYTES = 2_048;
const PERSISTED_PREFIX = '<persisted-output>';
const STALE_PREFIX = '[Stale output snipped:';

export function toolResultBytes(content: string): number { return Buffer.byteLength(content, 'utf8'); }

function byteLength(content: string): number { return Buffer.byteLength(content, 'utf8'); }

export function spillDirectory(workDir: string): string { return join(workDir, '.bitori', 'tool-results'); }

export function writeSpill(workDir: string, toolUseId: string, content: string): string {
  const directory = spillDirectory(workDir);
  mkdirSync(directory, {recursive: true});
  const path = join(directory, toolUseId);
  try { writeFileSync(path, content, {encoding: 'utf8', flag: 'wx'}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return path;
}

/** 预览替换体固定模板；同一输入永远生成同一输出，避免破坏 prompt cache。 */
export function buildSpillPreview(content: string, spillPath: string): string {
  const bytes = byteLength(content);
  const preview = Buffer.from(content, 'utf8').subarray(0, PREVIEW_BYTES).toString('utf8');
  const lines = preview.split('\n', 20).join('\n');
  return [
    PERSISTED_PREFIX,
    `输出太大（${Math.floor(bytes / 1024)}KB），完整内容已保存到：`,
    spillPath,
    '',
    `预览（前 2KB）：`,
    lines,
    ...(byteLength(lines) < bytes ? ['...'] : []),
    '</persisted-output>',
  ].join('\n');
}

function resultContent(result: ModelToolResultsItem['results'][number]): string {
  if (result.result.status === 'success') return typeof result.result.output.text === 'string' ? result.result.output.text : JSON.stringify(result.result.output);
  if ('partialOutput' in result.result && result.result.partialOutput) return typeof result.result.partialOutput.text === 'string' ? result.result.partialOutput.text : JSON.stringify(result.result.partialOutput);
  return result.result.error.message;
}

function withContent(result: ModelToolResultsItem['results'][number], content: string): ModelToolResultsItem['results'][number] {
  if (result.result.status === 'success') {
    const output = {...result.result.output};
    if ('text' in output) output.text = content; else output.persistedContent = content;
    return {...result, result: {...result.result, output}};
  }
  const partial = 'partialOutput' in result.result ? result.result.partialOutput : undefined;
  if (partial !== undefined) {
    const output = {...partial};
    if ('text' in output) output.text = content; else output.persistedContent = content;
    return {...result, result: {...result.result, partialOutput: output}};
  }
  return {...result, result: {...result.result, error: {...result.result.error, message: content}}};
}

function replaceResult(
  result: ModelToolResultsItem['results'][number],
  workDir: string,
  state: ToolResultReplacementState,
): ModelToolResultsItem['results'][number] {
  const frozen = state.getReplacement(result.callId);
  if (frozen !== undefined) return withContent(result, frozen);
  const original = resultContent(result);
  if (state.has(result.callId) || byteLength(original) <= SINGLE_RESULT_LIMIT) {
    state.record(result.callId, original, original);
    return result;
  }
  try {
    const replacement = buildSpillPreview(original, writeSpill(workDir, result.callId, original));
    state.record(result.callId, original, replacement);
    return withContent(result, replacement);
  } catch {
    // 磁盘失败只放弃本次替换，不阻断对话；该 id 未入账，下轮还能重试。
    return result;
  }
}

function aggregateReplace(
  results: ModelToolResultsItem['results'],
  workDir: string,
  state: ToolResultReplacementState,
): ModelToolResultsItem['results'] {
  let total = results.reduce((sum, result) => sum + byteLength(resultContent(result)), 0);
  if (total <= MESSAGE_AGGREGATE_LIMIT) return results;
  const next = [...results];
  for (const result of [...next].sort((a, b) => byteLength(resultContent(b)) - byteLength(resultContent(a)))) {
    if (total <= MESSAGE_AGGREGATE_LIMIT) break;
    const before = resultContent(result);
    if (byteLength(before) <= OLD_RESULT_SNIP_BYTES) continue;
    try {
      const replacement = buildSpillPreview(before, writeSpill(workDir, result.callId, before));
      const index = next.indexOf(result);
      next[index] = withContent(result, replacement);
      state.record(result.callId, before, replacement);
      total += byteLength(replacement) - byteLength(before);
    } catch { /* 保持原文，继续评估其他结果。 */ }
  }
  return next;
}

/** 请求前轻量预算：单个超大结果落盘、单轮聚合超标按大小落盘。 */
export function applyToolResultBudget(
  items: readonly ModelContextItem[],
  workDir: string,
  state: ToolResultReplacementState,
): ModelContextItem[] {
  const normalized = items.map(item => {
    if (item.type !== 'tool_results') return item;
    const results = aggregateReplace(item.results.map(result => replaceResult(result, workDir, state)), workDir, state);
    return {...item, results};
  });
  return snipStaleToolResults(normalized);
}

/** 旧轮次的中小结果不落盘，只在请求上下文中替换成稳定占位符。 */
export function snipStaleToolResults(items: readonly ModelContextItem[]): ModelContextItem[] {
  const turns = items.filter(item => item.type === 'assistant_iteration' && item.toolCalls.length === 0).length;
  if (turns <= KEEP_RECENT_TURNS) return [...items];
  const oldBoundary = turns - KEEP_RECENT_TURNS;
  let turnsSeen = 0;
  return items.map(item => {
    if (item.type === 'assistant_iteration' && item.toolCalls.length === 0) turnsSeen++;
    if (turnsSeen <= oldBoundary && item.type === 'tool_results') {
      const results = item.results.map(result => {
        const content = resultContent(result);
        if (content.startsWith(PERSISTED_PREFIX) || content.startsWith(STALE_PREFIX) || byteLength(content) <= OLD_RESULT_SNIP_BYTES) return result;
        return withContent(result, `${STALE_PREFIX} ${byteLength(content)} bytes]`);
      });
      return {...item, results};
    }
    return item;
  });
}
