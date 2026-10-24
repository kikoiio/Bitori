import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

/** [s02] 每个工具测试使用独立临时根，不接触用户真实工作区。 */
export class TemporaryWorkspace {
  private constructor(readonly root: string) {}
  static async create(): Promise<TemporaryWorkspace> { return new TemporaryWorkspace(await mkdtemp(join(tmpdir(), 'bitori-s02-'))); }
  async text(path: string, content: string): Promise<void> { const target = join(this.root, path); await mkdir(dirname(target), {recursive: true}); await writeFile(target, content, 'utf8'); }
  async binary(path: string, content: Uint8Array): Promise<void> { const target = join(this.root, path); await mkdir(dirname(target), {recursive: true}); await writeFile(target, content); }
  async link(path: string, target: string, type: 'file' | 'junction' = 'file'): Promise<boolean> { try { await symlink(target, join(this.root, path), type); return true; } catch { return false; } }
  async cleanup(): Promise<void> { await rm(this.root, {recursive: true, force: true}); }
}
