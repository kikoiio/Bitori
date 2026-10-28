import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {createDefaultRegistry, parseCommand, permissionTierArgument, CommandRegistry} from '../../../src/commands/registry.js';
import {loadUserCommands, renderBody} from '../../../src/commands/loader.js';

describe('Slash 命令', () => {
  it('解析命令名与参数', () => {
    expect(parseCommand('/help')).toEqual({name: 'help', args: ''});
    expect(parseCommand('/review src/app.ts')).toEqual({name: 'review', args: 'src/app.ts'});
    expect(parseCommand(' /review/security\t  src/app.ts  ')).toEqual({name: 'review/security', args: 'src/app.ts'});
    expect(parseCommand('/ permission strict')).toEqual({name: '', args: ''});
    expect(parseCommand('help')).toBeNull();
  });

  it('注册、别名、补全与冲突检测', () => {
    const registry = createDefaultRegistry();
    expect(registry.find('c')?.name).toBe('compact');
    expect(registry.complete('/c'.slice(1)).map(command => command.name)).toContain('compact');
    expect(() => registry.register({name: 'compact', aliases: [], type: 'local', description: '', action: 'compact'})).toThrow('命令冲突');
    expect(new CommandRegistry().registerIfAbsent({name: 'x', aliases: [], type: 'prompt', description: '', handler: () => ''})).toBe(true);
    expect(registry.find('mode')).toMatchObject({type: 'local', action: 'permission'});
    expect(registry.find('PLAN')).toBeUndefined();
  });

  it('加载用户 Markdown 命令、命名空间与 $ARGUMENTS', ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-cmd-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    onTestFinished(() => rmSync(home, {recursive: true, force: true}));
    mkdirSync(join(work, '.bitori', 'commands', 'review'), {recursive: true});
    writeFileSync(join(work, '.bitori', 'commands', 'review', 'security.md'), '---\ndescription: 安全审查\n---\n请审查 $ARGUMENTS 的安全问题', 'utf8');
    const registry = loadUserCommands(work, home, createDefaultRegistry());
    const command = registry.find('review/security');
    expect(command?.description).toBe('安全审查');
    expect(command?.type === 'prompt' && command.handler({workDir: work, args: 'login.ts'})).toContain('login.ts');
    expect(renderBody('没有占位', '参数')).toContain('参数');
  });

  it('权限档参数只接受规定值及中文别名', () => {
    for (const [input, expected] of [['strict', 'strict'], ['严格', 'strict'], ['default', 'default'], ['默认', 'default'], ['bypass', 'bypass'], ['放行', 'bypass']]) expect(permissionTierArgument(input!)).toBe(expected);
    for (const value of ['', 'STRICT', 'strict extra']) expect(permissionTierArgument(value)).toBeUndefined();
  });
});
