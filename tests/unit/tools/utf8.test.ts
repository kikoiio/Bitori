import {join} from 'node:path';
import {open} from 'node:fs/promises';
import {afterEach, describe, expect, it} from 'vitest';
import {assertUtf8Text, readLimitedUtf8, TextFileError, withTextBudget} from '../../../src/tools/utf8.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const workspaces: TemporaryWorkspace[] = []; afterEach(async () => { await Promise.all(workspaces.splice(0).map(item => item.cleanup())); });
describe('UTF-8 文本守卫', () => {
  it('严格解码中文和代码', () => expect(assertUtf8Text(Buffer.from('中文\nconst x = 1'))).toBe('中文\nconst x = 1'));
  it.each([[Uint8Array.of(0), 'binary_file'], [Uint8Array.of(0xc3, 0x28), 'invalid_utf8']])('区分二进制和无效 UTF-8 %#', (data, code) => { try { assertUtf8Text(data); throw new Error('未抛错'); } catch (error) { expect(error).toBeInstanceOf(TextFileError); expect((error as TextFileError).code).toBe(code); } });
  it('读取受限内容并报告完整字节数', async () => { const workspace = await TemporaryWorkspace.create(); workspaces.push(workspace); await workspace.text('large.txt', '中'.repeat(10)); expect(await readLimitedUtf8(join(workspace.root, 'large.txt'), 7)).toMatchObject({text: '中中', fileBytes: 30, truncation: {truncated: true, returnedUnits: 6}}); });
  it('只读取大文件前缀，截断不拆分字符并报告文件大小', async () => {
    const workspace = await TemporaryWorkspace.create(); workspaces.push(workspace); await workspace.text('large.txt', '🙂中a');
    const handle = await open(join(workspace.root, 'large.txt'), 'r+'); await handle.truncate(32 * 1024 * 1024); await handle.close();
    const result = await readLimitedUtf8(join(workspace.root, 'large.txt'), 4);
    expect(result).toMatchObject({text: '🙂', fileBytes: 32 * 1024 * 1024, truncation: {truncated: true, returnedUnits: 4}});
  });
  it('读取前及等待预算时响应取消', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readLimitedUtf8('unused', 10, controller.signal)).rejects.toBeDefined();
  });
  it('并发预算最多四项，排队任务可取消并释放后继续', async () => {
    const controller = new AbortController(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const tasks = Array.from({length: 4}, () => withTextBudget(controller.signal, async () => { started++; await gate; }));
    const queuedController = new AbortController();
    const queued = withTextBudget(queuedController.signal, async () => { started++; });
    queuedController.abort(); await expect(queued).rejects.toBeDefined();
    expect(started).toBe(4); release(); await Promise.all(tasks);
    await withTextBudget(controller.signal, async () => { started++; }); expect(started).toBe(5);
  });
});
