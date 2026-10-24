import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';

export const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface WorktreeResult {path: string; branch: string; headCommit: string; gitRoot: string}

export function isSafeSlug(slug: string): boolean { return SAFE_SLUG_RE.test(slug); }

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

export function resolveGitRoot(cwd: string): string { return git(cwd, ['rev-parse', '--show-toplevel']); }

function readGitHead(gitDir: string): {branch?: string; sha?: string} {
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: refs/heads/')) return {branch: head.slice('ref: refs/heads/'.length)};
  return SHA_RE.test(head) ? {sha: head} : {};
}

function resolveRef(gitDir: string, ref: string): string {
  const direct = join(gitDir, ref);
  if (existsSync(direct)) {
    const value = readFileSync(direct, 'utf8').trim();
    return SHA_RE.test(value) ? value : '';
  }
  const packed = join(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha && SHA_RE.test(sha)) return sha;
    }
  }
  return '';
}

/** [s13] 优先读文件系统，避免恢复已有 Worktree 时额外调用 git。 */
export function readWorktreeHeadSha(worktreePath: string): string {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) return '';
    const gitDir = resolve(worktreePath, pointer.slice('gitdir: '.length));
    const head = readGitHead(gitDir);
    if (head.sha) return head.sha;
    if (!head.branch) return '';
    const direct = resolveRef(gitDir, `refs/heads/${head.branch}`);
    if (direct) return direct;
    const commondirPath = join(gitDir, 'commondir');
    const common = existsSync(commondirPath) ? resolve(gitDir, readFileSync(commondirPath, 'utf8').trim()) : gitDir;
    return resolveRef(common, `refs/heads/${head.branch}`);
  } catch { return ''; }
}

function copySettings(repoRoot: string, worktreePath: string): void {
  const source = join(repoRoot, '.bitori');
  if (!existsSync(source)) return;
  // [s13] worktrees 位于 .bitori 内，不能把父目录复制进自身；只复制配置与记忆文件。
  for (const entry of readdirSync(source).filter(name => name !== 'worktrees')) {
    cpSync(join(source, entry), join(worktreePath, '.bitori', entry), {recursive: true});
  }
}

function linkDependencies(repoRoot: string, worktreePath: string): void {
  const source = join(repoRoot, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  // [s13] Windows 对目录符号链接有权限要求；junction 指向目录且不需要开发者模式。
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function copyIncludedFiles(repoRoot: string, worktreePath: string): void {
  const manifest = join(repoRoot, '.worktreeinclude');
  if (!existsSync(manifest)) return;
  for (const line of readFileSync(manifest, 'utf8').split('\n').map(item => item.trim()).filter(item => item && !item.startsWith('#') && !item.includes('..'))) {
    const source = join(repoRoot, line);
    if (!existsSync(source)) continue;
    const target = join(worktreePath, line);
    mkdirSync(dirname(target), {recursive: true});
    cpSync(source, target, {recursive: true});
  }
}

function postCreate(repoRoot: string, worktreePath: string): void {
  copySettings(repoRoot, worktreePath);
  linkDependencies(repoRoot, worktreePath);
  copyIncludedFiles(repoRoot, worktreePath);
}

/** [s13] slug 严格白名单；目录已存在时快速恢复，不重复执行 git worktree add。 */
export function createAgentWorktree(slug: string, workspaceRoot = process.cwd()): WorktreeResult {
  if (!isSafeSlug(slug)) throw new Error(`非法 Worktree 名称：${slug}`);
  const gitRoot = resolveGitRoot(workspaceRoot);
  const root = join(gitRoot, '.bitori', 'worktrees', slug);
  const branch = `worktree-${slug}`;
  if (!existsSync(root)) {
    mkdirSync(dirname(root), {recursive: true});
    git(gitRoot, ['worktree', 'add', '-b', branch, root, 'HEAD']);
  }
  const headCommit = readWorktreeHeadSha(root) || git(root, ['rev-parse', 'HEAD']);
  if (existsSync(root)) postCreate(gitRoot, root);
  return {path: root, branch, headCommit, gitRoot};
}

export function hasWorktreeChanges(worktreePath: string, headCommit: string | null): boolean {
  try {
    if (git(worktreePath, ['status', '--porcelain']).length > 0) return true;
    if (!headCommit) return false;
    const current = readWorktreeHeadSha(worktreePath) || git(worktreePath, ['rev-parse', 'HEAD']);
    return current !== headCommit;
  } catch { return true; }
}

export function removeAgentWorktree(worktreePath: string, branch: string, gitRoot: string): void {
  if (!resolve(worktreePath).startsWith(resolve(gitRoot))) throw new Error('Worktree 路径越界');
  try { git(gitRoot, ['worktree', 'remove', '--force', worktreePath]); }
  catch { git(gitRoot, ['worktree', 'remove', '--force', worktreePath]); }
  if (existsSync(worktreePath)) rmSync(worktreePath, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
  try { git(gitRoot, ['branch', '-D', branch]); } catch { /* 分支可能已被合并或删除。 */ }
}

export function listWorktrees(workspaceRoot = process.cwd()): WorktreeResult[] {
  const gitRoot = resolveGitRoot(workspaceRoot);
  const base = join(gitRoot, '.bitori', 'worktrees');
  if (!existsSync(base)) return [];
  return readdirSync(base, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => {
    const path = join(base, entry.name);
    return {path, branch: `worktree-${entry.name}`, headCommit: readWorktreeHeadSha(path), gitRoot};
  });
}

export function buildWorktreeNotice(parentRoot: string, worktreePath: string): string {
  return [
    `Worktree 已创建：${worktreePath}`,
    `后续文件与命令操作必须显式使用该绝对路径；主工作区仍是 ${parentRoot}。`,
    '完成后若无需保留变更，请调用 ExitWorktree 清理。',
  ].join('\n');
}
