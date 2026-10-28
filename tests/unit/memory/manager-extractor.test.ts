import {existsSync, readFileSync} from 'node:fs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {LLMClient, StreamEvent} from '../../../src/providers/types.js';
import {MemoryExtractor} from '../../../src/memory/extractor.js';
import {MemoryManager, parseFrontmatter} from '../../../src/memory/manager.js';

function client(text: string): LLMClient {
  return {async *streamChat(): AsyncIterable<StreamEvent> { yield {type: 'text_delta', text}; yield {type: 'completed', finishReason: 'stop'}; }};
}

describe('长期记忆', () => {
  it('解析 frontmatter 并生成轻量索引', ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    onTestFinished(() => rmSync(home, {recursive: true, force: true}));
    const manager = new MemoryManager(work, home);
    manager.write('project', 'style.md', {name: '代码风格', description: '注释使用中文', type: 'project'}, '源码注释使用中文。');
    expect(manager.buildSystemReminder()).toContain('代码风格');
    manager.rebuildIndex();
    const index = readFileSync(join(work, '.bitori', 'memory', 'MEMORY.md'), 'utf8');
    expect(index).toContain('- project/代码风格 (project): 注释使用中文');
    expect(Buffer.byteLength(index, 'utf8')).toBeLessThanOrEqual(25_000);
  });

  it('extractor 支持四类记忆、NONE 与索引重建', async ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    onTestFinished(() => rmSync(home, {recursive: true, force: true}));
    const manager = new MemoryManager(work, home);
    await new MemoryExtractor(manager, client('MEMORY_USER_PREFERENCE|终端偏好|喜欢简短回复|用户偏好简短中文回复。')).extract('用户：回复短一点');
    expect(existsSync(join(home, '.bitori', 'memory'))).toBe(true);
    expect(existsSync(join(work, '.bitori', 'memory', 'MEMORY.md'))).toBe(true);
    await new MemoryExtractor(manager, client('NONE')).extract('用户：谢谢');
    expect(manager.getMemories().length).toBe(1);
  });

  it('frontmatter 无元数据时回退项目知识', () => {
    expect(parseFrontmatter('正文')).toEqual({name: '未命名记忆', description: '', type: 'project'});
  });
});
