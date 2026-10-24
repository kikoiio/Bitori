import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {parseSkillFile} from './parser.js';
import type {Skill, SkillCatalogEntry} from './types.js';

/** [s10] 启动期只保留轻量目录；get 时重读磁盘实现热更新，失败回退缓存。 */
export class SkillLoader {
  readonly #workDir: string;
  readonly #homeDir: string;
  #skills = new Map<string, Skill>();

  constructor(workDir: string, homeDirectory = process.env.HOME ?? '') {
    this.#workDir = workDir;
    this.#homeDir = homeDirectory;
  }

  loadAll(): SkillCatalogEntry[] {
    this.#skills = new Map();
    for (const [root, source] of [[join(this.#homeDir, '.bitori', 'skills'), 'user'], [join(this.#workDir, '.bitori', 'skills'), 'project']] as const) {
      if (!existsSync(root)) continue;
      for (const path of this.#candidatePaths(root)) {
        try {
          const parsed = parseSkillFile(path);
          this.#skills.set(parsed.meta.name, {meta: parsed.meta, body: parsed.body, sourcePath: path, source});
        } catch { /* 单个坏 Skill 不阻断目录扫描。 */ }
      }
    }
    return this.catalog();
  }

  reload(): SkillCatalogEntry[] { return this.loadAll(); }

  #candidatePaths(root: string): string[] {
    const paths: string[] = [];
    for (const entry of readdirSync(root, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        const skill = join(root, entry.name, 'SKILL.md');
        if (existsSync(skill)) paths.push(skill);
      } else if (entry.name.endsWith('.md')) paths.push(join(root, entry.name));
    }
    return paths;
  }

  get(name: string): Skill | null { return this.#skills.get(name) ?? null; }
  getFresh(name: string): Skill | null {
    const cached = this.#skills.get(name);
    if (!cached) return null;
    try {
      const parsed = parseSkillFile(cached.sourcePath);
      return {...cached, meta: parsed.meta, body: parsed.body};
    } catch { return cached; }
  }
  catalog(): SkillCatalogEntry[] { return [...this.#skills.values()].map(skill => ({name: skill.meta.name, description: skill.meta.description, source: skill.source})); }
  names(): string[] { return [...this.#skills.keys()]; }
}

export function renderSkillBody(body: string, args: string): string {
  return body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args) : args ? `${body}\n\n${args}` : body;
}
