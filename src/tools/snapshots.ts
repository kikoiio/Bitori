import {createHash, randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {basename} from 'node:path/posix';

/** edit_file/write_file 提交前的可验证快照;撤销只恢复 Bitori 自己写过的内容。 */
export interface FileSnapshot {
  id: string;
  workspaceRoot: string;
  /** 工作区相对 posix 路径(展示用)。 */
  path: string;
  absolutePath: string;
  /** null 表示写入前文件不存在(write_file 新建),撤销时删除文件。 */
  preContent: string | null;
  /** Bitori 写入后内容的 sha256;撤销前当前内容必须仍等于它,拒绝盲目覆盖外部修改。 */
  postHash: string;
  toolName: string;
  createdAt: number;
  /** 同一时间戳内的记录顺序,保证撤销总能取到最近一次。 */
  order?: number;
}

const PREVIEW_LIMIT = 1024 * 1024;

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 亚毫秒单调时间戳。Date.now() 只有毫秒精度,同一毫秒里的两次写入无法区分先后,
 * 撤销会从并列的快照里挑到旧的那一个并误判成"被外部修改"。这里用进程内单调时钟
 * 保留亚毫秒精度,配合 record 的 order 序号保证排序严格。
 */
function now(): number {
  return performance.timeOrigin + performance.now();
}

export class SnapshotStore {
  /** 同一进程内单调递增的记录序号,用于时间戳相同时定序。 */
  #order = 0;
  constructor(readonly directory: string, readonly workspaceRoot: string, private readonly maxKeep = 200) {}

  static forWorkspace(workspaceRoot: string): SnapshotStore {
    const root = canonicalRoot(workspaceRoot);
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
    return new SnapshotStore(join(root, '.bitori', 'snapshots', hash), root);
  }

  /** 在提交点之前调用;失败只丢快照,绝不阻断写入本身。 */
  async record(input: {path: string; absolutePath: string; preContent: string | null; postContent: string; toolName: string}): Promise<FileSnapshot | null> {
    const preOverLimit = input.preContent !== null && Buffer.byteLength(input.preContent) > PREVIEW_LIMIT;
    if (preOverLimit) return null;
    const snapshot: FileSnapshot = {
      id: randomUUID(),
      workspaceRoot: this.workspaceRoot,
      path: input.path,
      absolutePath: input.absolutePath,
      preContent: input.preContent,
      postHash: sha256Text(input.postContent),
      toolName: input.toolName,
      createdAt: now(),
      order: ++this.#order,
    };
    await mkdir(this.directory, {recursive: true});
    await writeFile(join(this.directory, `${snapshot.id}.json`), JSON.stringify(snapshot), 'utf8');
    await this.#prune();
    return snapshot;
  }

  async list(): Promise<FileSnapshot[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return []; }
    const snapshots: FileSnapshot[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as FileSnapshot;
        if (parsed.workspaceRoot === this.workspaceRoot && isSafeTarget(parsed, this.workspaceRoot)) snapshots.push(parsed);
      } catch { /* 损坏的快照按不存在处理 */ }
    }
    return snapshots.sort((a, b) => b.createdAt - a.createdAt || (b.order ?? 0) - (a.order ?? 0));
  }

  /** path 省略时撤销全局最近一次,否则撤销该文件的最近一次。 */
  async undo(path?: string): Promise<{ok: boolean; message: string}> {
    const all = await this.list();
    const wanted = path === undefined || path === '' ? all[0] : all.find(snapshot => snapshot.path === normalizeRelative(path));
    if (!wanted) {
      return {ok: false, message: path ? `没有 ${path} 的修改快照:只记录 edit_file/write_file 成功提交过的写入` : '没有可撤销的文件修改快照'};
    }
    const target = wanted.absolutePath;
    if (!isSafeTarget(wanted, this.workspaceRoot)) return {ok: false, message: '快照指向工作区之外,已拒绝'};
    let current: string;
    try { current = await readFile(target, 'utf8'); } catch {
      await this.#discard(wanted.id);
      return {ok: false, message: `${wanted.path} 已不存在,快照过期,不做猜测恢复`};
    }
    if (sha256Text(current) !== wanted.postHash) {
      return {ok: false, message: `${wanted.path} 在 Bitori 写入后被外部修改,拒绝盲目覆盖。请先 read_file 查看当前内容,手动处理后再重试`};
    }
    if (wanted.preContent === null) {
      await unlink(target);
      await this.#discard(wanted.id);
      return {ok: true, message: `已删除 Bitori 新建的 ${wanted.path}`};
    }
    const mode = (await stat(target)).mode & 0o7777;
    const candidate = join(dirname(target), `.bitori-undo-${randomUUID()}.tmp`);
    const handle = await open(candidate, 'wx', 0o600);
    try {
      await handle.writeFile(wanted.preContent, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(candidate, target);
    await this.#discard(wanted.id);
    return {ok: true, message: `已撤销 ${wanted.path} 的最近一次 Bitori 修改(${basename(wanted.path)} ← ${wanted.toolName})`};
  }

  async #discard(id: string): Promise<void> {
    await rm(join(this.directory, `${id}.json`), {force: true}).catch(() => undefined);
  }

  async #prune(): Promise<void> {
    const all = await this.list();
    if (all.length <= this.maxKeep) return;
    for (const stale of all.slice(this.maxKeep)) await this.#discard(stale.id);
  }
}

/**
 * 与 WorkspacePaths 一致地用真实路径界定工作区。临时目录在 macOS 上是 /var 符号链接、
 * 在 Windows 上是 8.3 短路径，realpath 展开后与原字符串不同；两边不统一，
 * 合法快照会被当成"工作区之外"而丢弃，撤销就找不到任何修改。
 */
function canonicalRoot(workspaceRoot: string): string {
  try { return realpathSync(resolve(workspaceRoot)); } catch { return resolve(workspaceRoot); }
}

function isSafeTarget(snapshot: FileSnapshot, workspaceRoot: string): boolean {
  const target = resolve(snapshot.absolutePath);
  const rel = relative(workspaceRoot, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function normalizeRelative(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}
