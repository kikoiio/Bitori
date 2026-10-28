import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {buildWorktreeNotice, createAgentWorktree, hasWorktreeChanges, isSafeSlug, listWorktrees, readWorktreeHeadSha, removeAgentWorktree} from '../../../src/worktree/worktree.js';

let root: string;
let home: string;

function gitStatus(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], {cwd, encoding: 'utf8'}).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bitori-worktree-'));
  home = process.env.HOME!;
  process.env.HOME = root;
  execFileSync('git', ['init'], {cwd: root});
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: root});
  execFileSync('git', ['config', 'user.name', 'Test'], {cwd: root});
  writeFileSync(join(root, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], {cwd: root});
  execFileSync('git', ['commit', '-m', 'init'], {cwd: root});
});

afterAll(() => {
  process.env.HOME = home;
  rmSync(root, {recursive: true, force: true});
});

describe('Worktree', () => {
  it('slug 白名单与 SHA 读取', () => {
    expect(isSafeSlug('feature_x-1')).toBe(true);
    expect(isSafeSlug('../etc')).toBe(false);
    expect(isSafeSlug('a/b')).toBe(false);
    const worktree = createAgentWorktree('alice', root);
    expect(readWorktreeHeadSha(worktree.path)).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
  });

  it('创建后复制配置、链接依赖并生成提示', () => {
    mkdirSync(join(root, '.bitori'), {recursive: true});
    writeFileSync(join(root, '.bitori', 'config.yaml'), 'mcp_servers: {}', 'utf8');
    mkdirSync(join(root, 'node_modules', 'demo'), {recursive: true});
    writeFileSync(join(root, '.worktreeinclude'), '.env.local\n', 'utf8');
    writeFileSync(join(root, '.env.local'), 'KEY=1', 'utf8');
    const worktree = createAgentWorktree('setup', root);
    expect(existsSync(join(worktree.path, '.bitori', 'config.yaml'))).toBe(true);
    expect(existsSync(join(worktree.path, 'node_modules', 'demo'))).toBe(true);
    expect(existsSync(join(worktree.path, '.env.local'))).toBe(true);
    expect(buildWorktreeNotice(root, worktree.path)).toContain(worktree.path);
  });

  it('变更保护、列表与删除', () => {
    const worktree = createAgentWorktree('cleanup', root);
    // 创建后设置会写入 .bitori 与 .env.local，先确认不含对 HEAD 的实际改动。
    execFileSync('git', ['checkout', '--', '.'], {cwd: worktree.path});
    expect(gitStatus(worktree.path).split('\n').filter(line => !line.includes('.bitori/') && !line.includes('.env.local') && !line.includes('node_modules'))).toEqual([]);
    writeFileSync(join(worktree.path, 'README.md'), 'changed\n');
    expect(hasWorktreeChanges(worktree.path, worktree.headCommit)).toBe(true);
    expect(listWorktrees(root).some(item => item.path === worktree.path)).toBe(true);
    execFileSync('git', ['checkout', '--', '.'], {cwd: worktree.path});
    expect(hasWorktreeChanges(worktree.path, worktree.headCommit)).toBe(true); // 未跟踪设置文件按保守策略视为变更。
    removeAgentWorktree(worktree.path, worktree.branch, worktree.gitRoot);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('重复创建走快速恢复', () => {
    const first = createAgentWorktree('restore', root);
    const second = createAgentWorktree('restore', root);
    expect(second.path).toBe(first.path);
    expect(second.headCommit).toBe(first.headCommit);
    removeAgentWorktree(second.path, second.branch, second.gitRoot);
  });
});
