import {mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  isWorkspaceTrusted,
  loadTrustedWorkspaces,
  revokeWorkspace,
  trustedWorkspacesPath,
  trustWorkspace,
  workspaceHasProjectExtensions,
} from '../../../src/config/trust.js';

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
    writeFileSync(trustedWorkspacesPath(home), '{ not json', 'utf8');
    expect(loadTrustedWorkspaces(home)).toEqual([]);
    expect(isWorkspaceTrusted(workspace, home)).toBe(false);
  });

  it('识别项目级 MCP/Hooks 扩展文件', () => {
    expect(workspaceHasProjectExtensions(workspace)).toBe(false);
    mkdirSync(join(workspace, '.bitori'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'hooks.yaml'), 'hooks: []\n', 'utf8');
    expect(workspaceHasProjectExtensions(workspace)).toBe(true);
  });

  it('trust 写入的目录会自动创建', async () => {
    await trustWorkspace(workspace, join(home, 'missing-yet'));
    // 解析清单再比较：JSON 里的反斜杠是转义过的，直接对原始文本做子串匹配在 Windows 上不成立。
    const list = JSON.parse(readFileSync(trustedWorkspacesPath(join(home, 'missing-yet')), 'utf8')) as string[];
    expect(list).toContain(resolve(workspace));
  });
});
