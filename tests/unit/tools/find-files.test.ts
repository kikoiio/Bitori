import {afterEach, describe, expect, it} from 'vitest';
import {FindFilesTool} from '../../../src/tools/implementations/find-files.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup())));
describe('FindFilesTool', () => {
  it('匹配嵌套 Unicode 文件、排序并限制数量', async () => { const w = await TemporaryWorkspace.create(); items.push(w); await w.text('b.ts', ''); await w.text('nested/中文.ts', ''); await w.text('a.txt', ''); const result = await new FindFilesTool().execute({pattern: '**/*.ts'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 100, maxMatches: 1}}); expect(result).toMatchObject({status: 'success', output: {files: ['b.ts']}, truncation: {truncated: true, originalUnits: 2}}); });
  it('无匹配返回空结果', async () => { const w = await TemporaryWorkspace.create(); items.push(w); expect(await new FindFilesTool().execute({pattern: '*.missing'}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 1_000, maxResultBytes: 100, maxMatches: 10}})).toMatchObject({status: 'success', output: {files: []}}); });
});
