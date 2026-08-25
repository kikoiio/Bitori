import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createToolSystem} from '../../../src/tools/create-tool-system.js';
import {limitMatches, truncateUtf8} from '../../../src/tools/limits.js';
import {assertUtf8Text, TextFileError} from '../../../src/tools/utf8.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

describe('s02 工具核心', () => {
  it('只登记一次即可稳定导出六个工具', () => {
    const {registry} = createToolSystem(process.cwd());
    expect(registry.definitions().map(item => item.name)).toEqual(['read_file', 'write_file', 'edit_file', 'run_command', 'find_files', 'search_text']);
    expect(() => registry.register(registry.entries()[0]!)).toThrow(/重复/);
  });

  it('UTF-8 截断不切断中文或 emoji，并报告原始规模', () => {
    expect(truncateUtf8('中🙂a', 7)).toMatchObject({text: '中🙂', truncation: {truncated: true, originalUnits: 8, returnedUnits: 7}});
    expect(limitMatches([1, 2, 3], 2).truncation).toMatchObject({truncated: true, originalUnits: 3, returnedUnits: 2});
    expect(() => assertUtf8Text(Uint8Array.of(0))).toThrow(TextFileError);
  });

  it('创建、读取、唯一修改、查找和搜索均受工作区约束', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mycode-tools-')); roots.push(root);
    const {registry} = createToolSystem(root); const signal = new AbortController().signal;
    const context = {workspaceRoot: root, signal, limits: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500}};
    const write = registry.get('write_file')!; expect((await write.execute(write.parseArguments({path: '中文.ts', content: 'const x = 1;'}), context)).status).toBe('success');
    const read = registry.get('read_file')!; expect(await read.execute(read.parseArguments({path: '中文.ts'}), context)).toMatchObject({status: 'success', output: {content: 'const x = 1;'}});
    const edit = registry.get('edit_file')!; expect((await edit.execute(edit.parseArguments({path: '中文.ts', oldText: '1', newText: '2'}), context)).status).toBe('success');
    expect(await readFile(join(root, '中文.ts'), 'utf8')).toBe('const x = 2;');
    expect(await registry.get('find_files')!.execute({pattern: '**/*.ts'}, context)).toMatchObject({status: 'success', output: {files: ['中文.ts']}});
    expect(await registry.get('search_text')!.execute({query: 'x = 2'}, context)).toMatchObject({status: 'success', output: {matches: [{path: '中文.ts', line: 1, column: 7}]}});
    await writeFile(join(root, 'outside.txt'), 'safe');
    expect(await read.execute(read.parseArguments({path: '../outside.txt'}), context)).toMatchObject({status: 'error', error: {code: 'path_outside_workspace'}});
  });
});
