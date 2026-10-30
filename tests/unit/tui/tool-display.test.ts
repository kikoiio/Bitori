import {describe, expect, it} from 'vitest';
import type {ToolCallRecord} from '../../../src/storage/types.js';
import {callHeadline, collapseLabel, foldToolCalls, resultLine, sessionHunks} from '../../../src/tui/tool-display.js';

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'toolName'>): ToolCallRecord {
  return {
    sessionId: 's', assistantMessageId: 'm', providerCallId: 'p', position: 0, arguments: {},
    approvalStatus: 'not_required', executionStatus: 'succeeded', result: {status: 'success', output: {}},
    createdAt: 1, updatedAt: 1, ...partial,
  };
}

describe('foldToolCalls', () => {
  it('把连续成功的只读调用压成摘要，写操作保持展开', () => {
    const records = [
      record({id: 'r1', toolName: 'read_file', arguments: {path: 'a.ts'}}),
      record({id: 'r2', toolName: 'read_file', arguments: {path: 'b.ts'}}),
      record({id: 'r3', toolName: 'edit_file', arguments: {path: 'b.ts', oldText: 'beta', newText: 'BETA\nepsilon'}}),
      record({id: 'r4', toolName: 'search_text', arguments: {query: 'TODO'}}),
    ];
    expect(foldToolCalls(records, false)).toEqual([
      {kind: 'summary', collapseClass: 'read', count: 2},
      {kind: 'call', record: records[2]},
      {kind: 'summary', collapseClass: 'search', count: 1},
    ]);
    expect(collapseLabel('read', 2)).toBe('读取 2 个文件');
    expect(foldToolCalls(records, true).map(item => item.kind)).toEqual(['call', 'call', 'call', 'call']);
  });

  it('运行中的只读调用不折叠', () => {
    const records = [record({id: 'r1', toolName: 'read_file', arguments: {path: 'a.ts'}, executionStatus: 'running', result: null})];
    expect(foldToolCalls(records, false)).toEqual([{kind: 'call', record: records[0]}]);
    expect(callHeadline(records[0]!)).toBe('Reading a.ts');
  });
});

describe('callHeadline 与 resultLine', () => {
  it('命令行只保留首行参数，成功结果显示首行输出', () => {
    const rec = record({
      id: 'c', toolName: 'run_command', arguments: {command: 'python3 fib.py\n# comment'},
      result: {status: 'success', output: {exitCode: 0, stdout: '0 1 1 2 3\nmore', stderr: ''}},
    });
    expect(callHeadline(rec)).toBe('Bash(python3 fib.py)');
    expect(resultLine(rec, false)).toBe('0 1 1 2 3');
  });

  it('编辑结果显示新增/删除行数', () => {
    const rec = record({id: 'e', toolName: 'edit_file', arguments: {path: 'notes.txt', oldText: 'beta', newText: 'BETA\nepsilon'}});
    expect(callHeadline(rec)).toBe('Update(notes.txt)');
    expect(resultLine(rec, false)).toBe('新增 2 行，删除 1 行');
  });
});

describe('sessionHunks', () => {
  it('只收集本会话成功的写操作', () => {
    const records = [
      record({id: 'r', toolName: 'read_file', arguments: {path: 'a.ts'}}),
      record({id: 'w', toolName: 'write_file', arguments: {path: 'new.txt', content: 'hello'}}),
      record({id: 'e', toolName: 'edit_file', arguments: {path: 'a.ts', oldText: 'x', newText: 'y'}, executionStatus: 'failed', result: {status: 'error', error: {code: 'no_unique_match', message: 'x', retryable: false}}}),
    ];
    expect(sessionHunks(records)).toEqual([{path: 'new.txt', oldText: '', newText: 'hello'}]);
  });
});
