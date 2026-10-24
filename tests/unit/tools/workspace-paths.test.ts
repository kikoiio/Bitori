import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {WorkspacePaths} from '../../../src/tools/workspace-paths.js';
import type {WorkspacePathError} from '../../../src/tools/workspace-paths.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const cleanups: Array<() => Promise<void>> = []; afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
describe('WorkspacePaths', () => {
  it('解析内部文件、新文件父目录和搜索根', async () => { const w = await TemporaryWorkspace.create(); cleanups.push(() => w.cleanup()); await w.text('nested/中文.txt', 'ok'); const paths = await WorkspacePaths.create(w.root); expect(await paths.existingFile('nested/中文.txt')).toContain('中文.txt'); expect(await paths.newFile('nested/new.txt')).toContain('new.txt'); expect(await paths.searchRoot('nested')).toContain('nested'); });
  it.each(['', '..\\outside', '../outside', 'C:\\outside.txt'])('拒绝空、穿越和绝对路径：%s', async path => { const w = await TemporaryWorkspace.create(); cleanups.push(() => w.cleanup()); const paths = await WorkspacePaths.create(w.root); await expect(paths.existingFile(path)).rejects.toMatchObject({code: 'path_outside_workspace'} satisfies Partial<WorkspacePathError>); });
  it('拒绝不存在与目录目标', async () => { const w = await TemporaryWorkspace.create(); cleanups.push(() => w.cleanup()); const paths = await WorkspacePaths.create(w.root); await expect(paths.existingFile('missing')).rejects.toMatchObject({code: 'path_not_found'}); await expect(paths.existingFile('.')).rejects.toMatchObject({code: 'not_a_file'}); });
  it('拒绝链接逃逸（系统允许创建链接时）', async () => { const w = await TemporaryWorkspace.create(); const outside = await mkdtemp(join(tmpdir(), 'bitori-outside-')); cleanups.push(() => w.cleanup(), () => rm(outside, {recursive: true, force: true})); await writeFile(join(outside, 'secret.txt'), 'secret'); if (!(await w.link('escape.txt', join(outside, 'secret.txt')))) return; await expect((await WorkspacePaths.create(w.root)).existingFile('escape.txt')).rejects.toMatchObject({code: 'path_outside_workspace'}); });
});
