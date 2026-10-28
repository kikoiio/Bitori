import {chmod, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {WorkspacePaths} from '../../../src/tools/workspace-paths.js';
import {EditFileTool} from '../../../src/tools/implementations/edit-file.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup()))); const limits = {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500};
describe('EditFileTool', () => {
  it('直接调用已取消信号时不修改文件', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old');
    expect(await new EditFileTool().execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: AbortSignal.abort('stop'), limits})).toMatchObject({status: 'interrupted', error: {code: 'interrupted'}});
    expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old');
    expect(await readdir(w.root)).toEqual(['a.txt']);
  });
  it('路径检查期间取消时不创建临时文件', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const controller = new AbortController();
    const paths = await WorkspacePaths.create(w.root); const original = paths.existingFile.bind(paths);
    const check = vi.spyOn(WorkspacePaths.prototype, 'existingFile').mockImplementation(async path => {
      const target = await original(path); controller.abort(); return target;
    });
    const create = vi.fn(open);
    try {
      expect(await new EditFileTool({open: create, rename, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: controller.signal, limits})).toMatchObject({status: 'interrupted'});
      expect(create).not.toHaveBeenCalled();
      expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old');
      expect(await readdir(w.root)).toEqual(['a.txt']);
    } finally { check.mockRestore(); }
  });
  it('临时路径冲突时不删除其他调用的文件', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old');
    const create: typeof open = async (...args) => { await writeFile(args[0], 'other call'); return open(...args); };
    const remove = vi.fn(unlink);
    expect(await new EditFileTool({open: create, rename, unlink: remove}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'error', error: {code: 'path_already_exists'}});
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old');
    const foreign = (await readdir(w.root)).find(name => name.startsWith('.bitori-'));
    expect(foreign).toBeDefined();
    if (foreign) expect(await readFile(join(w.root, foreign), 'utf8')).toBe('other call');
  });
  it('创建临时文件期间取消时保留原文件并清理本次文件', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const controller = new AbortController();
    const create: typeof open = async (...args) => { const handle = await open(...args); controller.abort(); return handle; };
    expect(await new EditFileTool({open: create, rename, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: controller.signal, limits})).toMatchObject({status: 'interrupted'});
    expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old');
    expect(await readdir(w.root)).toEqual(['a.txt']);
  });
  it('临时文件关闭后、rename 提交前取消时保留原文件并清理临时文件', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const controller = new AbortController();
    const create: typeof open = async (...args) => {
      const handle = await open(...args); const close = handle.close.bind(handle);
      handle.close = async () => { await close(); controller.abort(); }; return handle;
    };
    expect(await new EditFileTool({open: create, rename, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: controller.signal, limits})).toMatchObject({status: 'interrupted'});
    expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old');
    expect(await readdir(w.root)).toEqual(['a.txt']);
  });
  it('rename 提交完成后的取消仍返回成功', async () => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const controller = new AbortController();
    const commit: typeof rename = async (...args) => { await rename(...args); controller.abort(); };
    expect(await new EditFileTool({open, rename: commit, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: controller.signal, limits})).toMatchObject({status: 'success'});
    expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('new');
    expect(await readdir(w.root)).toEqual(['a.txt']);
  });
  it('按字面唯一匹配 Unicode、多行及正则特殊字符', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', '头\n[a.*]\n尾'); expect(await new EditFileTool().execute({path: 'a.txt', oldText: '[a.*]', newText: '中文'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'success'}); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('头\n中文\n尾'); });
  it.each([['none', '0'], ['same same', '2']])('零次或多次匹配不修改：%s', async (content, count) => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', content); const result = await new EditFileTool().execute({path: 'a.txt', oldText: 'same', newText: 'x'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'error', error: {code: 'no_unique_match'}}); expect(result.status === 'error' && result.error.message).toContain(count); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe(content); });
  it('拒绝二进制、越界和空 oldText', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.binary('bin', Uint8Array.of(0)); const tool = new EditFileTool(); const context = {workspaceRoot: w.root, signal: new AbortController().signal, limits}; expect(await tool.execute({path: 'bin', oldText: 'x', newText: 'y'}, context)).toMatchObject({status: 'error', error: {code: 'binary_file'}}); expect(await tool.execute({path: '../x', oldText: 'x', newText: 'y'}, context)).toMatchObject({status: 'error', error: {code: 'path_outside_workspace'}}); expect(() => tool.parseArguments({path: 'a', oldText: '', newText: 'x'})).toThrow(); });
  it('提交替换失败时保留原文件并清理临时文件', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old'); const failingRename: typeof rename = async () => { throw new Error('simulated rename failure'); }; const result = await new EditFileTool({open, rename: failingRename, unlink}).execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits}); expect(result).toMatchObject({status: 'error', error: {code: 'internal_error'}}); expect(await readFile(join(w.root, 'a.txt'), 'utf8')).toBe('old'); expect((await readdir(w.root)).filter(name => name.startsWith('.bitori-'))).toEqual([]); });
  it.skipIf(process.platform === 'win32').each([0o600, 0o755])('保留原文件权限 %s', async mode => {
    const w = await TemporaryWorkspace.create(); items.push(w); await w.text('a.txt', 'old');
    const path = join(w.root, 'a.txt'); await chmod(path, mode);
    expect(await new EditFileTool().execute({path: 'a.txt', oldText: 'old', newText: 'new'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits})).toMatchObject({status: 'success'});
    expect((await stat(path)).mode & 0o7777).toBe(mode);
  });

});
