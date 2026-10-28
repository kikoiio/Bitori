import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export const MAX_MEMORY_INDEX_LINES = 200;
export const MAX_MEMORY_INDEX_BYTES = 25_000;
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryFile {path: string; name: string; description: string; type: MemoryType; content: string}
export interface MemoryHeader {filename: string; filePath: string; scope: 'user' | 'project'; mtimeMs: number; description: string; type: MemoryType}

export interface Frontmatter {name: string; description: string; type: MemoryType}

export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fallback: Frontmatter = {name: '未命名记忆', description: '', type: 'project'};
  if (!match) return fallback;
  const values = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const type = values.get('type');
  return {
    name: values.get('name') ?? fallback.name,
    description: values.get('description') ?? '',
    type: type === 'user' || type === 'feedback' || type === 'reference' ? type : 'project',
  };
}

/** 用户级与项目级记忆分目录存储；索引只保存可扫描的轻量摘要。 */
export class MemoryManager {
  readonly #workDir: string;
  readonly #userDir: string;
  readonly #projectDir: string;
  #memories: MemoryFile[] = [];

  constructor(workDir: string, homeDirectory = process.env.HOME ?? '') {
    this.#workDir = resolveWork(workDir);
    this.#userDir = join(homeDirectory, '.bitori', 'memory');
    this.#projectDir = join(this.#workDir, '.bitori', 'memory');
  }

  get directories(): readonly string[] { return [this.#userDir, this.#projectDir]; }
  getMemories(): readonly MemoryFile[] { return [...this.#memories]; }

  loadAll(): MemoryFile[] {
    const files: MemoryFile[] = [];
    for (const [directory, scope] of [[this.#userDir, 'user'], [this.#projectDir, 'project']] as const) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory).filter(name => name.endsWith('.md') && name !== 'MEMORY.md').sort()) {
        const path = join(directory, entry);
        const text = readFileSync(path, 'utf8');
        const meta = parseFrontmatter(text);
        files.push({path, name: `${scope}/${meta.name}`, description: meta.description, type: meta.type, content: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()});
      }
    }
    this.#memories = files;
    return [...files];
  }

  buildSystemReminder(): string {
    this.loadAll();
    if (this.#memories.length === 0) return '';
    return ['Active memories:', ...this.#memories.map(memory => `- [${memory.name}] (${memory.type}): ${memory.description}`)].join('\n');
  }

  rebuildIndex(): string {
    this.loadAll();
    const lines = ['# Memory Index', ...this.#memories.map(memory => `- ${memory.name} (${memory.type}): ${memory.description}`)];
    let index = lines.slice(0, MAX_MEMORY_INDEX_LINES).join('\n');
    if (Buffer.byteLength(index, 'utf8') > MAX_MEMORY_INDEX_BYTES) {
      while (Buffer.byteLength(index, 'utf8') > MAX_MEMORY_INDEX_BYTES && index.includes('\n')) index = index.slice(0, index.lastIndexOf('\n'));
    }
    mkdirSync(this.#projectDir, {recursive: true});
    const path = join(this.#projectDir, 'MEMORY.md');
    writeFileSync(path, index + '\n', 'utf8');
    return index;
  }

  clear(): void {
    for (const directory of this.directories) if (existsSync(directory)) for (const entry of readdirSync(directory).filter(name => name.endsWith('.md'))) rmSync(join(directory, entry));
    this.#memories = [];
  }

  write(scope: 'user' | 'project', filename: string, frontmatter: Frontmatter, content: string): string {
    const directory = scope === 'user' ? this.#userDir : this.#projectDir;
    mkdirSync(directory, {recursive: true});
    const path = join(directory, filename.endsWith('.md') ? filename : `${filename}.md`);
    writeFileSync(path, `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description}\ntype: ${frontmatter.type}\n---\n\n${content}\n`, 'utf8');
    return path;
  }
}

function resolveWork(workDir: string): string { return workDir; }
