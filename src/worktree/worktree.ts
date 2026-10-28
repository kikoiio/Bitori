import {constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

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

/** 优先读文件系统，避免恢复已有 Worktree 时额外调用 git。 */
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

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
}

function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function comparablePath(path: string): string {
  const canonical = canonicalPath(path);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** 不跟随任一目标目录链接，也不覆盖已有文件。 */
function ensureDirectory(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info = lstatIfPresent(current);
    if (!info) { try { mkdirSync(current); } catch (error) { if (!lstatIfPresent(current)) throw error; } info = lstatIfPresent(current); }
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  }
  return true;
}

function copyWithoutOverwrite(source: string, target: string, targetRoot: string): void {
  const info = lstatIfPresent(source);
  if (!info || info.isSymbolicLink()) return;
  if (!ensureDirectory(targetRoot, dirname(target))) return;
  if (info.isDirectory()) {
    if (!ensureDirectory(targetRoot, target)) return;
    for (const name of readdirSync(source)) copyWithoutOverwrite(join(source, name), join(target, name), targetRoot);
  } else if (info.isFile()) {
    try { copyFileSync(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error; }
  }
}

function copySettings(repoRoot: string, worktreePath: string): void {
  const source = join(repoRoot, '.bitori');
  const info = lstatIfPresent(source);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  // worktrees 位于 .bitori 内，不能把父目录复制进自身。
  for (const entry of readdirSync(source).filter(name => name !== 'worktrees')) {
    copyWithoutOverwrite(join(source, entry), join(worktreePath, '.bitori', entry), worktreePath);
  }
}

function linkDependencies(repoRoot: string, worktreePath: string): void {
  const source = join(repoRoot, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return;
  // Windows 对目录符号链接有权限要求；junction 指向目录且不需要开发者模式。
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function copyIncludedFiles(repoRoot: string, worktreePath: string): void {
  const manifest = join(repoRoot, '.worktreeinclude');
  if (!existsSync(manifest)) return;
  for (const line of readFileSync(manifest, 'utf8').split('\n').map(item => item.trim()).filter(item => item && !item.startsWith('#'))) {
    const normalized = line.replaceAll('\\', '/');
    if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some(part => part === '..')) continue;
    let source = repoRoot; let safe = true;
    for (const part of normalized.split('/').filter(part => part && part !== '.')) {
      source = join(source, part);
      if (lstatIfPresent(source)?.isSymbolicLink()) { safe = false; break; }
    }
    const target = resolve(worktreePath, normalized);
    if (safe && target !== worktreePath) copyWithoutOverwrite(source, target, worktreePath);
  }
}

function postCreate(repoRoot: string, worktreePath: string): void {
  copySettings(repoRoot, worktreePath);
  linkDependencies(repoRoot, worktreePath);
  copyIncludedFiles(repoRoot, worktreePath);
}

/** slug 严格白名单；目录已存在时快速恢复，不重复执行 git worktree add。 */
export function createAgentWorktree(slug: string, workspaceRoot = process.cwd()): WorktreeResult {
  if (!isSafeSlug(slug)) throw new Error(`非法 Worktree 名称：${slug}`);
  const gitRoot = resolveGitRoot(workspaceRoot);
  const root = join(gitRoot, '.bitori', 'worktrees', slug);
  const branch = `worktree-${slug}`;
  if (!existsSync(root)) {
    mkdirSync(dirname(root), {recursive: true});
    const branchExists = git(gitRoot, ['branch', '--list', branch]).length > 0;
    git(gitRoot, branchExists ? ['worktree', 'add', root, branch] : ['worktree', 'add', '-b', branch, root, 'HEAD']);
    postCreate(gitRoot, root);
  }
  if (resolve(git(root, ['rev-parse', '--show-toplevel'])) !== resolve(root) || git(root, ['symbolic-ref', '--short', 'HEAD']) !== branch) throw new Error('现有目录不是预期的 Worktree 或分支');
  const headCommit = readWorktreeHeadSha(root) || git(root, ['rev-parse', 'HEAD']);
  return {path: root, branch, headCommit, gitRoot};
}

export function hasWorktreeChanges(worktreePath: string, headCommit: string | null, gitRoot?: string): boolean {
  try {
    if (git(worktreePath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']).length > 0) return true;
    const current = readWorktreeHeadSha(worktreePath) || git(worktreePath, ['rev-parse', 'HEAD']);
    if (headCommit && current !== headCommit) return true;
    if (gitRoot && git(worktreePath, ['rev-list', '-n', '1', current, '--not', git(gitRoot, ['rev-parse', 'HEAD'])])) return true;
    return false;
  } catch { return true; }
}

export function removeAgentWorktree(worktreePath: string, branch: string, gitRoot: string, force = false): void {
  const slug = branch.startsWith('worktree-') ? branch.slice('worktree-'.length) : '';
  if (!isSafeSlug(slug) || comparablePath(worktreePath) !== comparablePath(join(gitRoot, '.bitori', 'worktrees', slug))) throw new Error('Worktree 路径越界');
  if (!force && hasWorktreeChanges(worktreePath, null, gitRoot)) throw new Error('Worktree 存在未提交文件或独有提交');
  git(gitRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
  if (force && existsSync(worktreePath)) rmSync(worktreePath, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
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

export function worktreeRelativePath(parentRoot: string, worktreePath: string): string | null {
  const path = relative(comparablePath(parentRoot), comparablePath(worktreePath));
  return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? path : null;
}

export function buildWorktreeNotice(parentRoot: string, worktreePath: string): string {
  const path = worktreeRelativePath(parentRoot, worktreePath);
  return [
    `Worktree 已创建或恢复：${worktreePath}`,
    '文件和命令工具仍从原工作区执行，不会自动切换。',
    path ? `文件工具使用相对路径 ${path}；运行命令时显式切换到该目录。` : '该 Worktree 在当前工作区之外，文件工具无法访问；运行命令时可显式切换到返回的绝对路径。',
    '退出时默认保留分支；未提交文件或独有提交需要 force=true 才能移除工作树。',
  ].join('\n');
}
