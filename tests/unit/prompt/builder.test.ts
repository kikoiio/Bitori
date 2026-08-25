import {describe, expect, it} from 'vitest';
import {buildSystemPrompt, SECTION_PRIORITY} from '../../../src/prompt/builder.js';
import type {EnvironmentInfo} from '../../../src/prompt/environment.js';

const env: EnvironmentInfo = {
  workspaceRoot: 'D:\\ws',
  os: 'win32 10.0.26200',
  nodeVersion: 'v24.0.0',
  date: '2026-08-24',
  profileName: 'main',
  model: 'claude',
};

describe('prompt builder', () => {
  it('七个固定模块按优先级顺序出现，环境信息位于最后', () => {
    const {text} = buildSystemPrompt(env);
    const titles = ['# 身份', '# 系统约束', '# 任务模式', '# 动作执行', '# 工具使用', '# 语气风格', '# 文本输出', '# 环境信息'];
    const positions = titles.map(title => text.indexOf(title));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < positions.length; index++) expect(positions[index]!).toBeGreaterThan(positions[index - 1]!);
  });

  it('模块之间以空行分隔', () => {
    const {blocks, text} = buildSystemPrompt(env);
    expect(text).toBe(blocks.map(block => block.text).join('\n\n'));
    expect(blocks[0]!.text).toContain('\n\n# 系统约束');
  });

  it('blocks 结构：稳定块可缓存，环境块不可缓存', () => {
    const {blocks} = buildSystemPrompt(env);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({cacheable: true});
    expect(blocks[1]).toMatchObject({cacheable: false});
    expect(blocks[1]!.text).toContain('# 环境信息');
  });

  it('可选模块注册后出现在环境信息之后，空内容模块被忽略', () => {
    const custom = {id: 'custom', priority: SECTION_PRIORITY.customInstructions, text: '# 自定义指令\n测试内容'};
    const empty = {id: 'empty', priority: SECTION_PRIORITY.skills, text: '   '};
    const {blocks, text} = buildSystemPrompt(env, [custom, empty]);
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toMatchObject({cacheable: false});
    expect(text.indexOf('# 环境信息')).toBeLessThan(text.indexOf('# 自定义指令'));
    expect(text).not.toContain('empty');
  });

  it('相同输入两次构建逐字节一致', () => {
    expect(buildSystemPrompt(env).text).toBe(buildSystemPrompt(env).text);
  });

  it('七个固定模块总量不超过约 4000 字符', () => {
    const {blocks} = buildSystemPrompt(env);
    expect(blocks[0]!.text.length).toBeLessThanOrEqual(4000);
  });
});
