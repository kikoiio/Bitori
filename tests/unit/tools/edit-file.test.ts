import {open, readFile, unlink} from 'node:fs/promises';
import type {rename} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {EditFileTool} from '../../../src/tools/implementations/edit-file.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup()))); const limits = {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500};
describe('EditFileTool', () => {
  it('按字面唯一匹配 Unicode、多行及正则特殊字符', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', '头\n[a.*]\n尾'); expect(await new EditFileTool().execute({path: 'a.txt', oldText: '[a.*]', newText: '中文'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'success'}); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('头\n中文\n尾'); });
  it.each([['none', '0'], ['same same', '2']])('零次或多次匹配不修改：%s', async (content, count) => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', content); const result = await new EditFileTool().execute({path: 'a.txt', oldText: 'same', newText: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'error', error: {code: 'no_unique_match'}}); expect(result.status === 'error' && result.error.message).toContain(count); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe(content); });
  it('拒绝二进制、越界和空 oldText', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.binary('bin', Uint8Array.of(0)); const tool = new EditFileTool(); const context = {workspaceRoot: w.root, signal: new AbortController().signal, limits}; expect(await tool.execute({path: 'bin', oldText: 'x', newText: 'y'}, context)).toMatchObject({status: 'error', error: {code: 'binary_file'}}); expect(await tool.execute({path: '../x', oldText: 'x', newText: 'y'}, context)).toMatchObject({status: 'error', error: {code: 'path_outside_workspace'}}); expect(() => tool.parseArguments({path: 'a', oldText: '', newText: 'x'})).toThrow(); });
  it('提交替换失败时保留原文件并清理临时文件', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const failingRename: typeof rename = async () => { throw new Error('simulated rename failure'); }; const result = await new EditFileTool({open, rename: failingRename, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'error', error: {code: 'internal_error'}}); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old'); expect((await readdir(w.root)).filter(name => name.startsWith('.mycode-'))).toEqual([]); });
});
