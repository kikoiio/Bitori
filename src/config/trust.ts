import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** 工作区信任清单：项目级 .bitori/config.yaml 会拉起 MCP/Hook 进程，必须由用户显式确认。 */
export function trustedWorkspacesPath(homeDirectory = homedir()): string {
  return join(homeDirectory, '.bitori', 'trusted-workspaces.json');
}

export function loadTrustedWorkspaces(homeDirectory = homedir()): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustedWorkspacesPath(homeDirectory), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').map(item => resolve(item)) : [];
  } catch {
    return [];
  }
}

export function isWorkspaceTrusted(workspaceRoot: string, homeDirectory = homedir()): boolean {
  const target = resolve(workspaceRoot);
  return loadTrustedWorkspaces(homeDirectory).includes(target);
}

/** 同步判断入口供 desktop/CLI 使用;写入走异步以避免阻塞渲染。 */
export async function trustWorkspace(workspaceRoot: string, homeDirectory = homedir()): Promise<void> {
  await writeTrustedList([...new Set([...loadTrustedWorkspaces(homeDirectory), resolve(workspaceRoot)])], homeDirectory);
}

export async function revokeWorkspace(workspaceRoot: string, homeDirectory = homedir()): Promise<boolean> {
  const target = resolve(workspaceRoot);
  const current = loadTrustedWorkspaces(homeDirectory);
  if (!current.includes(target)) return false;
  await writeTrustedList(current.filter(item => item !== target), homeDirectory);
  return true;
}

async function writeTrustedList(list: string[], homeDirectory: string): Promise<void> {
  const path = trustedWorkspacesPath(homeDirectory);
  await mkdir(join(homeDirectory, '.bitori'), {recursive: true});
  await writeFile(path, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/** 工作区是否自带需要信任才生效的扩展(项目级 MCP/Hooks 会在启动时拉起进程)。 */
export function workspaceHasProjectExtensions(workspaceRoot: string): boolean {
  const base = join(workspaceRoot, '.bitori');
  return existsSync(join(base, 'config.yaml')) || existsSync(join(base, 'hooks.yaml'));
}
