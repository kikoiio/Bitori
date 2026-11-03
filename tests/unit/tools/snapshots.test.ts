import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EditFileTool} from '../../../src/tools/implementations/edit-file.js';
import {WriteFileTool} from '../../../src/tools/implementations/write-file.js';
import {sha256Text, SnapshotStore} from '../../../src/tools/snapshots.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const limits = {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500};

describe('SnapshotStore 文件修改快照与撤销', () => {
  let root: string;
  let store: SnapshotStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bitori-snapshots-'));
    store = new SnapshotStore(join(root, 'snap'), root);
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('撤销 edit_file:恢复提交前内容并丢弃快照', async () => {
    const file = join(root, 'edit.txt');
    await writeFile(file, 'before', 'utf8');
    await store.record({path: 'edit.txt', absolutePath: file, preContent: 'before', postContent: 'after', toolName: 'edit_file'});
    await writeFile(file, 'after', 'utf8');
    const result = await store.undo();
    expect(result.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('before');
    expect(await store.list()).toHaveLength(0);
  });

  it('撤销 write_file 新建:文件被删除', async () => {
    const file = join(root, 'created.txt');
    await store.record({path: 'created.txt', absolutePath: file, preContent: null, postContent: 'fresh', toolName: 'write_file'});
    await writeFile(file, 'fresh', 'utf8');
    const result = await store.undo('created.txt');
    expect(result.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('当前内容被外部修改:拒绝盲目覆盖,文件保持不变', async () => {
    const file = join(root, 'external.txt');
    await store.record({path: 'external.txt', absolutePath: file, preContent: 'old', postContent: 'ours', toolName: 'edit_file'});
    await writeFile(file, 'someone-else', 'utf8');
    const result = await store.undo('external.txt');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('被外部修改');
    expect(await readFile(file, 'utf8')).toBe('someone-else');
    await rm(join(store.directory, (await store.list()).find(s => s.path === 'external.txt')!.id + '.json'));
  });

  it('目标已不存在:快照过期而不是凭空恢复', async () => {
    const result = await store.undo('missing.txt');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有 missing.txt 的修改快照');
  });

  it('同一文件多次修改:撤销最近一次', async () => {
    const file = join(root, 'multi.txt');
    await writeFile(file, 'v0', 'utf8');
    await store.record({path: 'multi.txt', absolutePath: file, preContent: 'v0', postContent: 'v1', toolName: 'edit_file'});
    await writeFile(file, 'v1', 'utf8');
    await store.record({path: 'multi.txt', absolutePath: file, preContent: 'v1', postContent: 'v2', toolName: 'edit_file'});
    await writeFile(file, 'v2', 'utf8');
    expect((await store.undo('multi.txt')).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v1');
    expect((await store.undo('multi.txt')).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v0');
  });

  it('同一时间戳的快照按写入顺序撤销最近一次', async () => {
    const directory = join(root, 'tie');
    const tieStore = new SnapshotStore(directory, root);
    const file = join(root, 'tie.txt');
    await writeFile(file, 'v2', 'utf8');
    await mkdir(directory, {recursive: true});
    const base = {workspaceRoot: root, path: 'tie.txt', absolutePath: file, preContent: 'v0', toolName: 'edit_file', createdAt: 1000};
    await writeFile(join(directory, 'first.json'), JSON.stringify({...base, id: 'first', postHash: sha256Text('v1'), order: 1}));
    await writeFile(join(directory, 'second.json'), JSON.stringify({...base, id: 'second', postHash: sha256Text('v2'), order: 2}));
    const result = await tieStore.undo('tie.txt');
    expect(result.ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v0');
  });

  it('工作区之外的快照路径被忽略', async () => {
    const file = join(root, 'inside.txt');
    await writeFile(file, 'a', 'utf8');
    await store.record({path: 'inside.txt', absolutePath: file, preContent: 'a', postContent: 'b', toolName: 'edit_file'});
    await writeFile(file, 'b', 'utf8');
    const all = await store.list();
    const target = all.find(snapshot => snapshot.path === 'inside.txt');
    expect(target).toBeTruthy();
    const hostile = new SnapshotStore(store.directory, join(root, 'other-root'));
    expect(await hostile.list()).toHaveLength(0);
    await store.undo('inside.txt');
  });

  it('EditFileTool/WriteFileTool 成功后自动记录快照并可撤销', async () => {
    const workspace = await TemporaryWorkspace.create();
    const storeInWorkspace = SnapshotStore.forWorkspace(workspace.root);
    await workspace.text('a.txt', 'one two three');
    const edit = new EditFileTool(undefined, storeInWorkspace);
    const context = {workspaceRoot: workspace.root, signal: new AbortController().signal, limits};
    expect(await edit.execute({path: 'a.txt', oldText: 'two', newText: '2'}, context)).toMatchObject({status: 'success'});
    expect(await readFile(join(workspace.root, 'a.txt'), 'utf8')).toBe('one 2 three');
    expect(await storeInWorkspace.undo()).toMatchObject({ok: true});
    expect(await readFile(join(workspace.root, 'a.txt'), 'utf8')).toBe('one two three');

    const write = new WriteFileTool(undefined, storeInWorkspace);
    expect(await write.execute({path: 'new.txt', content: 'hello'}, context)).toMatchObject({status: 'success'});
    expect(existsSync(join(workspace.root, 'new.txt'))).toBe(true);
    expect((await storeInWorkspace.list())[0]?.preContent).toBeNull();
    expect(await storeInWorkspace.undo('new.txt')).toMatchObject({ok: true});
    expect(existsSync(join(workspace.root, 'new.txt'))).toBe(false);
    await workspace.cleanup();
  });

  it('快照 hash 基于内容而非路径', () => {
    expect(sha256Text('abc')).toBe(sha256Text('abc'));
    expect(sha256Text('abc')).not.toBe(sha256Text('abd'));
  });

  it('超过上限的旧快照被裁剪', async () => {
    const small = new SnapshotStore(join(root, 'small'), root, 2);
    const file = join(root, 'prune.txt');
    await writeFile(file, 'x', 'utf8');
    for (let index = 0; index < 4; index += 1) {
      await small.record({path: 'prune.txt', absolutePath: file, preContent: `p${index}`, postContent: 'x', toolName: 'edit_file'});
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const listed = await small.list();
    expect(listed.length).toBeLessThanOrEqual(2);
    const mode = await stat(file);
    expect(mode.isFile()).toBe(true);
  });
});
