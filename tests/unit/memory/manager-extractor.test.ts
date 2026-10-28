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

  it('一次提取失败后仍执行已排队的提取', async ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    let calls = 0;
    const model: LLMClient = {async *streamChat() {
      if (++calls === 1) throw new Error('失败');
      yield {type: 'text_delta', text: 'NONE'};
    }};
    const extractor = new MemoryExtractor(new MemoryManager(work, work), model);
    const first = extractor.extract('first');
    const second = extractor.extract('second');
    await expect(first).rejects.toThrow('失败');
    await expect(second).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('关闭时取消运行中的提取，等待其结束并丢弃排队工作', async ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const model: LLMClient = {async *streamChat(_request, signal) {
      calls++; started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      yield {type: 'text_delta', text: 'MEMORY_PROJECT_KNOWLEDGE|x|x|x'};
    }};
    const manager = new MemoryManager(work, work);
    const extractor = new MemoryExtractor(manager, model);
    const first = extractor.extract('first');
    await startedPromise;
    const second = extractor.extract('second');
    await extractor.close();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(manager.getMemories()).toEqual([]);
    await expect(extractor.extract('third')).rejects.toThrow('关闭');
  });
});
