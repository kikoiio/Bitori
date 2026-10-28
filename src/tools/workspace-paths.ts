import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {realpath, stat} from 'node:fs/promises';

export class WorkspacePathError extends Error {
  constructor(readonly code: 'path_outside_workspace' | 'path_not_found' | 'not_a_file', message: string) { super(message); }
}
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
/** 所有文件工具共用真实路径边界，避免规范化及链接逃逸。 */
export class WorkspacePaths {
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<WorkspacePaths> { return new WorkspacePaths(await realpath(root)); }
  #syntactic(relativePath: string): string {
    const normalized = relativePath.replaceAll('\\', '/');
    if (!normalized || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) throw new WorkspacePathError('path_outside_workspace', '路径必须是工作区内的非空相对路径');
    const candidate = resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) throw new WorkspacePathError('path_outside_workspace', '路径位于工作区之外');
    return candidate;
  }
  /** 权限管线校验 glob 等尚未落到具体文件的相对路径表达式。 */
  validateRelative(relativePath: string): void { this.#syntactic(relativePath); }
  async existingFile(relativePath: string): Promise<string> {
    let actual: string;
    try { actual = await realpath(this.#syntactic(relativePath)); }
    catch (error) { if (error instanceof WorkspacePathError) throw error; throw new WorkspacePathError('path_not_found', '目标文件不存在'); }
    if (!isInside(this.root, actual)) throw new WorkspacePathError('path_outside_workspace', '链接目标位于工作区之外');
    if (!(await stat(actual)).isFile()) throw new WorkspacePathError('not_a_file', '目标不是普通文件');
    return actual;
  }
  async newFile(relativePath: string): Promise<string> {
    const candidate = this.#syntactic(relativePath);
    const parent = await realpath(dirname(candidate)).catch(() => { throw new WorkspacePathError('path_not_found', '父目录不存在'); });
    if (!isInside(this.root, parent)) throw new WorkspacePathError('path_outside_workspace', '父目录链接到工作区之外');
    return candidate;
  }
  async searchRoot(relativePath = '.'): Promise<string> {
    const actual = await realpath(this.#syntactic(relativePath)).catch(() => { throw new WorkspacePathError('path_not_found', '搜索目录不存在'); });
    if (!isInside(this.root, actual)) throw new WorkspacePathError('path_outside_workspace', '搜索目录位于工作区之外');
    return actual;
  }
}
