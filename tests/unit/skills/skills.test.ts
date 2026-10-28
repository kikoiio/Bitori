import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseSkillText} from '../../../src/skills/parser.js';
import {SkillLoader} from '../../../src/skills/loader.js';
import {ActiveSkills, SkillExecutor} from '../../../src/skills/executor.js';

describe('Skill 系统', () => {
  it('解析 frontmatter 并记录不支持的执行选项', () => {
    const parsed = parseSkillText('---\nname: review\ndescription: 审查\nallowed-tools: read_file, search_text\nmode: fork\nfork-context: recent\nmodel: low\n---\n请审查 $ARGUMENTS');
    expect(parsed.meta).toEqual({name: 'review', description: '审查', unsupportedFields: ['allowed-tools', 'fork-context', 'model', 'mode']});
    expect(parseSkillText('---\nname: bad\nmode: strange\nfork-context: strange\n---\n正文').meta.unsupportedFields).toEqual(['fork-context', 'mode']);
    expect(() => parseSkillText('正文')).toThrow('缺少 name');
  });

  it('两级加载、项目覆盖用户、热更新回退', () => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-skills-'));
    let home: string | undefined;
    try {
      home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
      mkdirSync(join(home, '.bitori', 'skills'), {recursive: true});
      mkdirSync(join(work, '.bitori', 'skills', 'review'), {recursive: true});
      writeFileSync(join(home, '.bitori', 'skills', 'common.md'), '---\nname: common\ndescription: 用户级\n---\n用户正文', 'utf8');
      writeFileSync(join(work, '.bitori', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: 项目级\n---\n项目正文', 'utf8');
      const loader = new SkillLoader(work, home);
      expect(loader.loadAll()).toEqual([
        {name: 'common', description: '用户级', source: 'user'},
        {name: 'review', description: '项目级', source: 'project'},
      ]);
      writeFileSync(join(work, '.bitori', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: 更新\n---\n新正文', 'utf8');
      expect(loader.getFresh('review')?.meta.description).toBe('更新');
    } finally {
      try {
        if (home) rmSync(home, {recursive: true, force: true});
      } finally {
        rmSync(work, {recursive: true, force: true});
      }
    }
  });

  it('激活 Skill 渲染环境段并清空未提供的参数', () => {
    const active = new ActiveSkills();
    const executor = new SkillExecutor(active);
    const skill = {meta: {name: 'commit', description: ''}, body: '提交 $ARGUMENTS', sourcePath: '/tmp/SKILL.md', source: 'project' as const};
    expect(executor.executeInline(skill)).toBe('提交 ');
    expect(active.render()).toContain('### Skill: commit');
  });
});
