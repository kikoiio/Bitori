import {open, readFile, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {WriteFileTool} from '../../../src/tools/implementations/write-file.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup()))); const limits = {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500};
describe('WriteFileTool', () => {
  it('排他创建 UTF-8 文本', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const result = await new WriteFileTool().execute({path: '新建.txt', content: '中文'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'success', output: {bytes: 6}}); expect(await readFile(join(w.root, '新建.txt'), 'utf8')).toBe('中文'); });
  it('不覆盖已有目标', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('exists.txt', 'original'); expect(await new WriteFileTool().execute({path: 'exists.txt', content: 'new'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'error', error: {code: 'path_already_exists'}}); expect(await readFile(join(w.root, 'exists.txt'), 'utf8')).toBe('original'); });
  it.each([['missing/new.txt', 'path_not_found'], ['../escape.txt', 'path_outside_workspace']])('拒绝非法目标 %s', async (path, code) => { const w = await TemporaryWorkspace.create(); items.push(w); expect(await new WriteFileTool().execute({path, content: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'error', error: {code}}); });
  it('Schema 不接受 cwd、超时或审批字段', () => expect(() => new WriteFileTool().parseArguments({path: 'x', content: 'x', timeoutMs: 1})).toThrow());
  it('写入中途失败清理本次创建的残缺目标', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const failingOpen: typeof open = async (...args) => { const handle = await open(...args); const original = handle.writeFile.bind(handle); handle.writeFile = (async () => { await original('partial', 'utf8'); throw new Error('simulated write failure'); }) as typeof handle.writeFile; return handle; }; const result = await new WriteFileTool({open: failingOpen, unlink}).execute({path: 'partial.txt', content: 'complete'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'error', error: {code: 'internal_error'}}); expect(existsSync(join(w.root, 'partial.txt'))).toBe(false); });
});
