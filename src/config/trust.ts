import {lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** 工作区信任清单：项目级 .bitori/config.yaml 会拉起 MCP/Hook 进程，必须由用户显式确认。 */
export function trustedWorkspacesPath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.bitori', 'trusted-workspaces.json');
}

export function loadTrustedWorkspaces(homeDirectory = homedir()): string[] {
  let fd: number | undefined;
  try {
    const path = trustedWorkspacesPath(homeDirectory);
    const before = lstatSync(path);
    if (!before.isFile()) return [];
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) return [];
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if ((uid !== undefined && opened.uid !== uid) || (opened.mode & 0o077) !== 0) return [];
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    // Reject the entire manifest: partially accepting corrupt input could grant trust.
    if (!Array.isArray(parsed) || !parsed.every((item): item is string =>
      typeof item === 'string' && item.trim().length > 0 && !item.includes('\0'))) return [];
    return [...new Set(parsed.map(item => resolve(item)))];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isWorkspaceTrusted(workspaceRoot: string, homeDirectory = homedir()): boolean {
  const target = resolve(workspaceRoot);
  return loadTrustedWorkspaces(homeDirectory).includes(target);
}

/** 同步判断入口供 desktop/CLI 使用;写入走异步以避免阻塞渲染。 */
export async function trustWorkspace(workspaceRoot: string, homeDirectory = homedir()): Promise<void> {
  await updateTrustedList(homeDirectory, async () => {
    await writeTrustedList([...new Set([...loadTrustedWorkspaces(homeDirectory), resolve(workspaceRoot)])], homeDirectory);
  });
}

export async function revokeWorkspace(workspaceRoot: string, homeDirectory = homedir()): Promise<boolean> {
  return updateTrustedList(homeDirectory, async () => {
    const target = resolve(workspaceRoot);
    const current = loadTrustedWorkspaces(homeDirectory);
    if (!current.includes(target)) return false;
    await writeTrustedList(current.filter(item => item !== target), homeDirectory);
    return true;
  });
}

// Keep the entire read/modify/write transaction ordered, including after failures.
const pendingUpdates = new Map<string, Promise<unknown>>();

async function updateTrustedList<T>(homeDirectory: string, update: () => Promise<T>): Promise<T> {
  const key = resolve(trustedWorkspacesPath(homeDirectory));
  const previous = pendingUpdates.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(update);
  pendingUpdates.set(key, next);
  try {
    return await next;
  } finally {
    if (pendingUpdates.get(key) === next) pendingUpdates.delete(key);
  }
}

async function assertRegularManifest(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Workspace trust manifest must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeTrustedList(list: string[], homeDirectory: string): Promise<void> {
  const path = trustedWorkspacesPath(homeDirectory);
  await mkdir(join(homeDirectory, '.bitori'), {recursive: true, mode: 0o700});
  await assertRegularManifest(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  // Exclusive creation cannot follow or truncate a pre-existing temporary symlink.
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(list, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await assertRegularManifest(path);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

/** 工作区是否自带需要信任才生效的扩展(项目级 MCP/Hooks 会在启动时拉起进程)。 */
export function workspaceHasProjectExtensions(workspaceRoot: string): boolean {
  const base = join(workspaceRoot, '.bitori');
  return existsSync(join(base, 'config.yaml')) || existsSync(join(base, 'hooks.yaml'));
}

/** 项目级提示、技能、命令、Agent 和权限规则也会影响模型行为，需先显式信任。 */
export function workspaceHasProjectContent(workspaceRoot: string): boolean {
  const base = join(workspaceRoot, '.bitori');
  return workspaceHasProjectExtensions(workspaceRoot)
    || existsSync(join(base, 'permissions.yaml'))
    || existsSync(join(base, 'permissions.local.yaml'))
    || ['BITORI.md', 'AGENTS.md'].some(name => existsSync(join(base, name)) || existsSync(join(workspaceRoot, name)))
    || ['memory', 'skills', 'commands', 'agents'].some(name => existsSync(join(base, name)));
}
