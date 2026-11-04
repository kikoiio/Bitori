import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, lstatSync, readdirSync, chmodSync, linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  isWorkspaceTrusted,
  loadTrustedWorkspaces,
  revokeWorkspace,
  trustedWorkspacesPath,
  trustWorkspace,
  workspaceHasProjectContent,
  workspaceHasProjectExtensions,
} from '../../../src/config/trust.js';

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

let home = '';
let workspace = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bitori-trust-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'bitori-trust-ws-'));
});
afterEach(() => {
  rmSync(home, {recursive: true, force: true});
  rmSync(workspace, {recursive: true, force: true});
});

describe('工作区信任清单', () => {
  it('默认不信任;trust 后信任;revoke 后恢复不信任', async () => {
    expect(isWorkspaceTrusted(workspace, home)).toBe(false);
    await trustWorkspace(workspace, home);
    expect(isWorkspaceTrusted(workspace, home)).toBe(true);
    expect(existsSync(trustedWorkspacesPath(home))).toBe(true);
    expect(await revokeWorkspace(workspace, home)).toBe(true);
    expect(isWorkspaceTrusted(workspace, home)).toBe(false);
    expect(await revokeWorkspace(workspace, home)).toBe(false);
  });

  it('重复 trust 不产生重复条目', async () => {
    await trustWorkspace(workspace, home);
    await trustWorkspace(workspace, home);
    expect(loadTrustedWorkspaces(home)).toHaveLength(1);
  });

  it('损坏的清单文件按空处理而不是崩溃', () => {
    mkdirSync(join(home, '.bitori'), {recursive: true});
    writeFileSync(trustedWorkspacesPath(home), '{ not json', {encoding: 'utf8', mode: 0o600});
    expect(loadTrustedWorkspaces(home)).toEqual([]);
    expect(isWorkspaceTrusted(workspace, home)).toBe(false);
  });

  it.each([null, {}, 'workspace', [123], ['', 'valid'], ['  '], ['bad\0path']].map((parsed: unknown) => ({parsed})))(
    '拒绝整个无效清单: $parsed', ({parsed}) => {
      mkdirSync(join(home, '.bitori'));
      const entries = Array.isArray(parsed) ? parsed.map((entry: unknown) => entry) : null;
      writeFileSync(trustedWorkspacesPath(home), JSON.stringify(
        entries === null ? parsed : [workspace, ...entries],
      ), {mode: 0o600});
      expect(loadTrustedWorkspaces(home)).toEqual([]);
      expect(isWorkspaceTrusted(workspace, home)).toBe(false);
    },
  );

  it('拒绝非普通文件且不覆盖它', async () => {
    mkdirSync(trustedWorkspacesPath(home), {recursive: true});
    expect(loadTrustedWorkspaces(home)).toEqual([]);
    await expect(trustWorkspace(workspace, home)).rejects.toThrow('regular file');
    expect(statSync(trustedWorkspacesPath(home)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('不读取或覆盖符号链接清单（包括悬空链接）', async () => {
    mkdirSync(join(home, '.bitori'));
    const target = join(home, 'outside.json');
    const original = JSON.stringify([workspace]);
    writeFileSync(target, original);
    symlinkSync(target, trustedWorkspacesPath(home));
    expect(loadTrustedWorkspaces(home)).toEqual([]);
    expect(await revokeWorkspace(workspace, home)).toBe(false);
    await expect(trustWorkspace(workspace, home)).rejects.toThrow('regular file');
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(lstatSync(trustedWorkspacesPath(home)).isSymbolicLink()).toBe(true);
    rmSync(target);
    await expect(trustWorkspace(workspace, home)).rejects.toThrow('regular file');
    expect(existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('临时符号链接不能覆盖目标，失败后仍能写入', async () => {
    await trustWorkspace(workspace, home);
    const target = join(home, 'outside.txt');
    writeFileSync(target, 'keep me');
    const temporary = `${trustedWorkspacesPath(home)}.00000000-0000-4000-8000-000000000000.tmp`;
    symlinkSync(target, temporary);
    const second = join(workspace, 'second');
    await expect(trustWorkspace(second, home)).rejects.toMatchObject({code: 'EEXIST'});
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
    expect(loadTrustedWorkspaces(home)).toEqual([resolve(workspace)]);
    rmSync(temporary);
    await trustWorkspace(second, home);
    expect(loadTrustedWorkspaces(home)).toContain(resolve(second));
    expect(readdirSync(join(home, '.bitori'))).toEqual(['trusted-workspaces.json']);
  });

  it.skipIf(process.platform === 'win32')('新建目录与清单使用私有权限，替换旧文件也收紧权限', async () => {
    await trustWorkspace(workspace, home);
    expect(statSync(join(home, '.bitori')).mode & 0o777).toBe(0o700);
    expect(statSync(trustedWorkspacesPath(home)).mode & 0o777).toBe(0o600);
    chmodSync(trustedWorkspacesPath(home), 0o666);
    expect(loadTrustedWorkspaces(home)).toEqual([]);
    await trustWorkspace(workspace, home);
    expect(statSync(trustedWorkspacesPath(home)).mode & 0o777).toBe(0o600);
    expect(loadTrustedWorkspaces(home)).toEqual([resolve(workspace)]);
  });

  it('同一清单的并发 trust 与 revoke 按调用顺序更新，不丢失条目', async () => {
    const second = join(workspace, 'second');
    const third = join(workspace, 'third');
    const results = await Promise.all([
      trustWorkspace(workspace, home),
      trustWorkspace(second, home),
      revokeWorkspace(workspace, home),
      trustWorkspace(third, home),
      revokeWorkspace(second, home),
      trustWorkspace(workspace, home),
    ]);
    expect(results[2]).toBe(true);
    expect(results[4]).toBe(true);
    expect(loadTrustedWorkspaces(home)).toEqual([resolve(third), resolve(workspace)]);
  });

  it('通过替换文件发布完整清单，不修改原文件的其他硬链接', async () => {
    await trustWorkspace(workspace, home);
    const original = readFileSync(trustedWorkspacesPath(home), 'utf8');
    const snapshot = join(home, 'previous-manifest.json');
    linkSync(trustedWorkspacesPath(home), snapshot);
    await trustWorkspace(join(workspace, 'second'), home);
    expect(readFileSync(snapshot, 'utf8')).toBe(original);
    expect(loadTrustedWorkspaces(home)).toHaveLength(2);
  });

  it('识别项目级 MCP/Hooks 扩展文件', () => {
    expect(workspaceHasProjectExtensions(workspace)).toBe(false);
    mkdirSync(join(workspace, '.bitori'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'hooks.yaml'), 'hooks: []\n', 'utf8');
    expect(workspaceHasProjectExtensions(workspace)).toBe(true);
  });

  it('把项目提示、记忆、权限规则、skills、commands 与 agents 计入信任边界', () => {
    expect(workspaceHasProjectContent(workspace)).toBe(false);
    writeFileSync(join(workspace, 'AGENTS.md'), '项目说明', 'utf8');
    expect(workspaceHasProjectContent(workspace)).toBe(true);
  });

  it('只存在项目记忆时也提示用户需信任工作区', () => {
    mkdirSync(join(workspace, '.bitori', 'memory'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'memory', 'pref.md'), '---\nname: preference\ndescription: concise\ntype: user\n---\nUse concise replies.');
    expect(workspaceHasProjectContent(workspace)).toBe(true);
  });

  it('把 permissions.local.yaml 计入信任边界', () => {
    mkdirSync(join(workspace, '.bitori'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'permissions.local.yaml'), 'mode: bypass\n', 'utf8');
    expect(workspaceHasProjectContent(workspace)).toBe(true);
  });

  it('trust 写入的目录会自动创建', async () => {
    await trustWorkspace(workspace, join(home, 'missing-yet'));
    // 解析清单再比较：JSON 里的反斜杠是转义过的，直接对原始文本做子串匹配在 Windows 上不成立。
    const list = JSON.parse(readFileSync(trustedWorkspacesPath(join(home, 'missing-yet')), 'utf8')) as string[];
    expect(list).toContain(resolve(workspace));
  });
});
