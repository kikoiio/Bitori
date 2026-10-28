import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {ReadFileTool} from '../../../src/tools/implementations/read-file.js';
import {EnterWorktreeTool, ExitWorktreeTool} from '../../../src/tools/implementations/worktree-tools.js';
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

  it('干净工作树可非强制移除，分支可重新恢复', async () => {
    const enter = new EnterWorktreeTool(); const exit = new ExitWorktreeTool(enter);
    const context = {workspaceRoot: root, signal: new AbortController().signal, limits: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500}};
    const result = await enter.execute({slug: 'clean'}, context);
    expect(result).toMatchObject({status: 'success', output: {relativePath: join('.bitori', 'worktrees', 'clean')}});
    expect(await new ReadFileTool().execute({path: join('.bitori', 'worktrees', 'clean', 'README.md')}, context)).toMatchObject({status: 'success', output: {content: 'init\n'}});
    expect(await exit.execute({slug: 'clean', force: false})).toMatchObject({status: 'success'});
    expect(await exit.execute({slug: 'clean', force: false})).toMatchObject({status: 'error', error: {code: 'path_not_found'}});
    expect(await enter.execute({slug: 'clean'}, context)).toMatchObject({status: 'success'});
    expect(await exit.execute({slug: 'clean', force: false})).toMatchObject({status: 'success'});
  });

  it('git 拒绝移除时不回退删除目录', () => {
    const worktree = createAgentWorktree('locked', root);
    execFileSync('git', ['worktree', 'lock', worktree.path], {cwd: root});
    expect(() => removeAgentWorktree(worktree.path, worktree.branch, root)).toThrow();
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n')).toBe('init\n');
    execFileSync('git', ['worktree', 'unlock', worktree.path], {cwd: root});
    removeAgentWorktree(worktree.path, worktree.branch, root);
  });

  it('已提交的独有工作在退出和恢复后受保护，强制退出也保留分支', async () => {
    const enter = new EnterWorktreeTool(); const exit = new ExitWorktreeTool(enter);
    const context = {workspaceRoot: root, signal: new AbortController().signal, limits: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500}};
    expect(await enter.execute({slug: 'committed'}, context)).toMatchObject({status: 'success'});
    const path = join(root, '.bitori', 'worktrees', 'committed');
    writeFileSync(join(path, 'README.md'), 'committed work\n');
    execFileSync('git', ['add', 'README.md'], {cwd: path}); execFileSync('git', ['commit', '-m', 'work'], {cwd: path});
    expect(await exit.execute({slug: 'committed', force: false})).toMatchObject({status: 'error', error: {code: 'permission_denied'}});
    const restored = new EnterWorktreeTool(); const restoredExit = new ExitWorktreeTool(restored);
    expect(await restored.execute({slug: 'committed'}, context)).toMatchObject({status: 'success'});
    expect(await restoredExit.execute({slug: 'committed', force: false})).toMatchObject({status: 'error', error: {code: 'permission_denied'}});
    expect(await restoredExit.execute({slug: 'committed', force: true})).toMatchObject({status: 'success'});
    expect(existsSync(path)).toBe(false);
    expect(execFileSync('git', ['show', 'worktree-committed:README.md'], {cwd: root, encoding: 'utf8'})).toBe('committed work\n');
  });

  it('非强制移除保护忽略文件', () => {
    const worktree = createAgentWorktree('ignored', root);
    writeFileSync(join(worktree.path, '.gitignore'), 'ignored.txt\n');
    execFileSync('git', ['add', '.gitignore'], {cwd: worktree.path});
    execFileSync('git', ['commit', '-m', 'ignore file'], {cwd: worktree.path});
    expect(hasWorktreeChanges(worktree.path, null)).toBe(false);
    writeFileSync(join(worktree.path, 'ignored.txt'), 'local data');
    expect(hasWorktreeChanges(worktree.path, null)).toBe(true);
    expect(() => removeAgentWorktree(worktree.path, worktree.branch, root)).toThrow();
    expect(readFileSync(join(worktree.path, 'ignored.txt'), 'utf8')).toBe('local data');
    removeAgentWorktree(worktree.path, worktree.branch, root, true);
  });

  it('首次复制 include 文件不覆盖工作树中已有的受跟踪文件', () => {
    writeFileSync(join(root, '.worktreeinclude'), 'README.md\n');
    writeFileSync(join(root, 'README.md'), 'local source\n');
    const worktree = createAgentWorktree('include', root);
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n')).toBe('init\n');
    removeAgentWorktree(worktree.path, worktree.branch, root);
    rmSync(join(root, '.worktreeinclude')); writeFileSync(join(root, 'README.md'), 'init\n');
  });

  it.skipIf(process.platform === 'win32')('初始化不会通过目标目录符号链接写入外部目录', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bitori-link-repo-'));
    const outside = mkdtempSync(join(tmpdir(), 'bitori-link-outside-'));
    try {
      execFileSync('git', ['init'], {cwd: repo});
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: repo});
      execFileSync('git', ['config', 'user.name', 'Test'], {cwd: repo});
      mkdirSync(join(repo, 'nested')); symlinkSync(outside, join(repo, 'nested', 'link'));
      symlinkSync(outside, join(repo, '.bitori'));
      execFileSync('git', ['add', '.'], {cwd: repo}); execFileSync('git', ['commit', '-m', 'link'], {cwd: repo});
      rmSync(join(repo, 'nested', 'link')); mkdirSync(join(repo, 'nested', 'link'));
      rmSync(join(repo, '.bitori')); mkdirSync(join(repo, '.bitori')); writeFileSync(join(repo, '.bitori', 'config.yaml'), 'settings');
      writeFileSync(join(repo, 'nested', 'link', 'victim.txt'), 'source');
      writeFileSync(join(repo, 'nested', 'link', 'new.txt'), 'source');
      writeFileSync(join(outside, 'victim.txt'), 'external');
      writeFileSync(join(repo, '.worktreeinclude'), 'nested\n');
      const worktree = createAgentWorktree('links', repo);
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('external');
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
      expect(existsSync(join(outside, 'config.yaml'))).toBe(false);
      removeAgentWorktree(worktree.path, worktree.branch, repo, true);
    } finally { rmSync(repo, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); }
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
    removeAgentWorktree(worktree.path, worktree.branch, worktree.gitRoot, true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('重复创建走快速恢复', () => {
    const first = createAgentWorktree('restore', root);
    writeFileSync(join(first.path, '.bitori', 'config.yaml'), 'local config');
    writeFileSync(join(first.path, '.env.local'), 'local env');
    const second = createAgentWorktree('restore', root);
    expect(readFileSync(join(second.path, '.bitori', 'config.yaml'), 'utf8')).toBe('local config');
    expect(readFileSync(join(second.path, '.env.local'), 'utf8')).toBe('local env');
    expect(second.path).toBe(first.path);
    expect(second.headCommit).toBe(first.headCommit);
    removeAgentWorktree(second.path, second.branch, second.gitRoot, true);
  });
});
