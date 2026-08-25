import {afterEach, describe, expect, it} from 'vitest';
import {SearchTextTool} from '../../../src/tools/implementations/search-text.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup())));
describe('SearchTextTool', () => {
  it('返回普通文本的一基行列并支持同一行多匹配', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.ts', '第一行\nfoo foo'); await w.text('b.txt', 'foo'); const result = await new SearchTextTool().execute({query: 'foo', filePattern: '*.ts'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 100, maxMatches: 10}}); expect(result).toMatchObject({status: 'success', output: {matches: [{path: 'a.ts', line: 2, column: 1}, {path: 'a.ts', line: 2, column: 5}]}}); });
  it('跳过二进制/无效 UTF-8并截断匹配', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'x x x'); await w.binary('bin.dat', Uint8Array.of(0)); const result = await new SearchTextTool().execute({query: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 100, maxMatches: 2}}); expect(result).toMatchObject({status: 'success', output: {skippedFiles: 1}, truncation: {truncated: true, originalUnits: 3, returnedUnits: 2}}); });
  it('Schema 拒绝空查询和额外字段', () => { const tool = new SearchTextTool(); expect(() => tool.parseArguments({query: ''})).toThrow(); expect(() => tool.parseArguments({query: 'x', regex: true})).toThrow(); });
});
