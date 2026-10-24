import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createDefaultRegistry, parseCommand, CommandRegistry} from '../../../src/commands/registry.js';
import {loadUserCommands, renderBody} from '../../../src/commands/loader.js';
import {CommandUsageTracker} from '../../../src/commands/usage-tracker.js';

describe('Slash 命令', () => {
  it('解析命令名与参数', () => {
    expect(parseCommand('/help')).toEqual({name: 'help', args: ''});
    expect(parseCommand('/review src/app.ts')).toEqual({name: 'review', args: 'src/app.ts'});
    expect(parseCommand('help')).toBeNull();
  });

  it('注册、别名、补全与冲突检测', () => {
    const registry = createDefaultRegistry();
    expect(registry.find('c')?.name).toBe('compact');
    expect(registry.complete('/c'.slice(1)).map(command => command.name)).toContain('compact');
    expect(() => registry.register({name: 'compact', aliases: [], type: 'local', description: '', handler: () => ''})).toThrow('命令冲突');
    expect(new CommandRegistry().registerIfAbsent({name: 'x', aliases: [], type: 'local', description: '', handler: () => ''})).toBe(true);
  });

  it('加载用户 Markdown 命令、命名空间与 $ARGUMENTS', () => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-cmd-'));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    mkdirSync(join(work, '.bitori', 'commands', 'review'), {recursive: true});
    writeFileSync(join(work, '.bitori', 'commands', 'review', 'security.md'), '---\ndescription: 安全审查\n---\n请审查 $ARGUMENTS 的安全问题', 'utf8');
    const registry = loadUserCommands(work, home, createDefaultRegistry());
    const command = registry.find('review/security');
    expect(command?.description).toBe('安全审查');
    expect(command?.handler({workDir: work, args: 'login.ts'})).toContain('login.ts');
    expect(renderBody('没有占位', '参数')).toContain('参数');
  });

  it('使用统计持久化并按最近使用排序', () => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-cmd-'));
    const path = join(work, 'usage.json');
    const tracker = new CommandUsageTracker(path);
    tracker.record('help', 100);
    tracker.record('compact', 200);
    expect(new CommandUsageTracker(path).recentlyUsed()).toEqual(['compact', 'help']);
    expect(tracker.score('compact')).toBeGreaterThan(0);
  });
});
