import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {ModelContextItem, ModelToolResultsItem} from '../../../src/providers/types.js';
import {applyToolResultBudget, buildSpillPreview, writeSpill} from '../../../src/toolresult/budget.js';
import {ToolResultReplacementState} from '../../../src/toolresult/state.js';

function result(callId: string, output: string): ModelToolResultsItem {
  return {type: 'tool_results', assistantMessageId: 'assistant', results: [{callId, providerCallId: callId, name: 'read_file', result: {status: 'success', output: {text: output}}}]};
}
function content(item: ModelContextItem): string {
  if (item.type !== 'tool_results') return '';
  if (item.type !== 'tool_results' || item.results[0]!.result.status !== 'success') return '';
  const text = item.results[0]!.result.output.text;
  return typeof text === 'string' ? text : JSON.stringify(item.results[0]!.result.output);
}

describe('工具结果预算', () => {
  it('单个超大结果落盘并生成稳定预览', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bitori-budget-'));
    try {
      const output = 'a'.repeat(51_000);
      const state = new ToolResultReplacementState();
      const next = applyToolResultBudget([result('call-1', output)], workspace, state);
      expect(content(next[0]!)).toContain('<persisted-output>');
      expect(content(next[0]!)).toContain('完整内容已保存到');
      const spill = join(workspace, '.bitori', 'tool-results', 'call-1');
      expect(readFileSync(spill, 'utf8')).toBe(output);
      expect(buildSpillPreview(output, spill)).toBe(buildSpillPreview(output, spill));
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });

  it('同一工具结果只落盘一次，且决策冻结', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bitori-budget-'));
    try {
      const output = 'b'.repeat(51_000);
      writeSpill(workspace, 'call-2', output);
      const before = statSync(join(workspace, '.bitori', 'tool-results', 'call-2')).mtimeMs;
      const state = new ToolResultReplacementState();
      const first = applyToolResultBudget([result('call-2', output)], workspace, state);
      const second = applyToolResultBudget([result('call-2', output)], workspace, state);
      expect(statSync(join(workspace, '.bitori', 'tool-results', 'call-2')).mtimeMs).toBe(before);
      expect(content(first[0]!)).toBe(content(second[0]!));
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });

  it('单轮聚合超标时按大小依次落盘', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bitori-budget-'));
    try {
      const item: ModelToolResultsItem = {type: 'tool_results', assistantMessageId: 'assistant', results: [
        {callId: 'small', providerCallId: null, name: 'read_file', result: {status: 'success', output: {text: 'small'}}},
        {callId: 'large-a', providerCallId: null, name: 'read_file', result: {status: 'success', output: {text: 'a'.repeat(120_000)}}},
        {callId: 'large-b', providerCallId: null, name: 'read_file', result: {status: 'success', output: {text: 'b'.repeat(130_000)}}},
      ]};
      const next = applyToolResultBudget([item], workspace, new ToolResultReplacementState()) as ModelToolResultsItem[];
      const serialized = next[0]!.results.map(entry => JSON.stringify(entry.result)).join('');
      expect(Buffer.byteLength(serialized)).toBeLessThan(210_000);
      expect(serialized).toContain('<persisted-output>');
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });
});
