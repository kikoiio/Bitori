import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {discoverInstructions, loadInstructions} from '../../../src/memory/instructions.js';

describe('指令文件', () => {
  it('按用户级、项目 .bitori、项目根顺序加载', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    mkdirSync(join(home, '.bitori'), {recursive: true});
    mkdirSync(join(root, '.bitori'), {recursive: true});
    writeFileSync(join(home, '.bitori', 'BITORI.md'), '用户级', 'utf8');
    writeFileSync(join(root, '.bitori', 'BITORI.md'), '项目配置', 'utf8');
    writeFileSync(join(root, 'BITORI.md'), '项目根', 'utf8');
    const sources = discoverInstructions(root, home);
    expect(sources.map(source => source.content)).toEqual(['用户级', '项目配置', '项目根']);
    expect(loadInstructions(root, home)).toContain('项目根');
  });

  it('@include 展开并阻止环路、越界与超深嵌套', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-memory-'));
    writeFileSync(join(root, 'module.md'), '模块内容', 'utf8');
    writeFileSync(join(root, 'BITORI.md'), '@include module.md', 'utf8');
    const sources = discoverInstructions(root, root);
    expect(sources[0]!.content).toBe('模块内容');
    writeFileSync(join(root, 'loop.md'), '@include loop.md', 'utf8');
    expect(discoverInstructions(root, root).length).toBe(1);
  });
});
