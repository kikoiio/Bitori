import {afterEach, describe, expect, it} from 'vitest';
import {SearchTextTool} from '../../../src/tools/implementations/search-text.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup())));
describe('SearchTextTool', () => {
  it('返回普通文本的一基行列并支持同一行多匹配', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.ts', '第一行\nfoo foo'); await w.text('b.txt', 'foo'); const result = await new SearchTextTool().execute({query: 'foo', filePattern: '*.ts'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 512, maxMatches: 10}}); expect(result).toMatchObject({status: 'success', output: {matches: [{path: 'a.ts', line: 2, column: 1}, {path: 'a.ts', line: 2, column: 5}]}}); });
  it('跳过二进制/无效 UTF-8并截断匹配', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'x x x'); await w.binary('bin.dat', Uint8Array.of(0)); const result = await new SearchTextTool().execute({query: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 512, maxMatches: 2}}); expect(result).toMatchObject({status: 'success', output: {countComplete: false}, truncation: {truncated: true, originalUnits: 3, returnedUnits: 2}}); });
  it('限制长行输出并标记不完整，及时响应取消', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('long.txt', 'x' + '中'.repeat(30_000));
    const tool = new SearchTextTool(); const controller = new AbortController();
    const context = {workspaceRoot: w.root, signal: controller.signal, limits: {timeoutMs: 1_000, maxResultBytes: 6000, maxMatches: 10}};
    const result = await tool.execute({query: 'x'}, context);
    expect(result).toMatchObject({status: 'success', output: {countComplete: false}, truncation: {truncated: true}});
    if (result.status === 'success') expect(Buffer.byteLength(JSON.stringify(result.output.matches))).toBeLessThanOrEqual(6000);
    controller.abort(); expect(await tool.execute({query: 'x'}, context)).toMatchObject({status: 'interrupted'});
  });
  it('达到结果上限后不继续计数', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('many.txt', 'x '.repeat(10000));
    const result = await new SearchTextTool().execute({query: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1000, maxResultBytes: 16000, maxMatches: 2}});
    expect(result).toMatchObject({status: 'success', output: {countComplete: false}, truncation: {originalUnits: 3, returnedUnits: 2, truncated: true}});
  });
  it('Schema 拒绝空查询和额外字段', () => { const tool = new SearchTextTool(); expect(() => tool.parseArguments({query: ''})).toThrow(); expect(() => tool.parseArguments({query: 'x', regex: true})).toThrow(); });
});
