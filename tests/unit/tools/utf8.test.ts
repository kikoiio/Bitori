import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {assertUtf8Text, readLimitedUtf8, TextFileError} from '../../../src/tools/utf8.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const workspaces: TemporaryWorkspace[] = []; afterEach(async () => { await Promise.all(workspaces.splice(0).map(item => item.cleanup())); });
describe('UTF-8 文本守卫', () => {
  it('严格解码中文和代码', () => expect(assertUtf8Text(Buffer.from('中文\nconst x = 1'))).toBe('中文\nconst x = 1'));
  it.each([[Uint8Array.of(0), 'binary_file'], [Uint8Array.of(0xc3, 0x28), 'invalid_utf8']])('区分二进制和无效 UTF-8 %#', (data, code) => { try { assertUtf8Text(data); throw new Error('未抛错'); } catch (error) { expect(error).toBeInstanceOf(TextFileError); expect((error as TextFileError).code).toBe(code); } });
  it('读取受限内容并报告完整字节数', async () => { const workspace = await TemporaryWorkspace.create(); workspaces.push(workspace); await workspace.text('large.txt', '中'.repeat(10)); expect(await readLimitedUtf8(join(workspace.root, 'large.txt'), 7)).toMatchObject({text: '中中', fileBytes: 30, truncation: {truncated: true, returnedUnits: 6}}); });
});
