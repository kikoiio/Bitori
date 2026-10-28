import {afterEach, describe, expect, it} from 'vitest';
import {ReadFileTool} from '../../../src/tools/implementations/read-file.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup())));
const limits = {timeoutMs: 10_000, maxResultBytes: 8, maxMatches: 500};
describe('ReadFileTool', () => {
  it('读取中文、换行与代码并安全截断', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('代码.ts', '中文\nconst x = 1'); const result = await new ReadFileTool().execute({path: '代码.ts'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'success', output: {path: '代码.ts', content: '中文\nc'}, truncation: {truncated: true}}); });
  const rejections: Array<[string, string]> = process.platform === 'win32' ? [['missing.txt', 'path_not_found'], ['..\\escape.txt', 'path_outside_workspace']] : [['missing.txt', 'path_not_found']];
  it.each(rejections)('结构化拒绝 %s', async (path, code) => { const w = await TemporaryWorkspace.create(); items.push(w); expect(await new ReadFileTool().execute({path}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'error', error: {code}}); });
  it('拒绝二进制和无效 UTF-8', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.binary('bin.dat', Uint8Array.of(1, 0, 2)); await w.binary('bad.txt', Uint8Array.of(0xc3, 0x28)); const tool = new ReadFileTool(); const context = {workspaceRoot: w.root, signal: new AbortController().signal, limits}; expect(await tool.execute({path: 'bin.dat'}, context)).toMatchObject({status: 'error', error: {code: 'binary_file'}}); expect(await tool.execute({path: 'bad.txt'}, context)).toMatchObject({status: 'error', error: {code: 'invalid_utf8'}}); });
  it('取消时返回 interrupted', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const controller = new AbortController(); controller.abort(); expect(await new ReadFileTool().execute({path: 'x'}, {workspaceRoot: w.root, signal: controller.signal, limits})).toMatchObject({status: 'interrupted'}); });
  it('Schema 拒绝额外限制参数', () => expect(() => new ReadFileTool().parseArguments({path: 'x', maxResultBytes: 1})).toThrow());
});
