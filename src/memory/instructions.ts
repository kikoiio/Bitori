import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';

const MAX_INCLUDE_DEPTH = 5;
const INSTRUCTION_FILENAMES = ['BITORI.md', 'AGENTS.md'] as const;

export interface InstructionSource {path: string; content: string}

function safeIncludePath(allowedRoot: string, base: string, include: string): string {
  const raw = include.trim().replace(/^["']|["']$/g, '');
  const path = isAbsolute(raw) ? raw : resolve(dirname(base), raw);
  const root = resolve(allowedRoot);
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`@include 路径越界：${include}`);
  return path;
}

function expandIncludes(path: string, allowedRoot: string, visited: Set<string>, depth: number): string {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error(`@include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层`);
  const root = realpathSync(resolve(allowedRoot));
  const lexical = resolve(path);
  if (!existsSync(lexical)) return `<!-- @include 未找到：${path} -->`;
  const canonical = realpathSync(lexical);
  if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error(`指令文件路径越界：${path}`);
  if (visited.has(canonical)) return '';
  visited.add(canonical);
  return readFileSync(canonical, 'utf8').replace(/@(?:include|import)\s+([^\n]+)/g, (_match, include: string) => {
    const target = safeIncludePath(root, canonical, include);
    if (!existsSync(target)) return `<!-- @include 未找到：${include.trim()} -->`;
    return expandIncludes(target, root, visited, depth + 1);
  });
}

function candidates(workDir: string, home: string): Array<string | undefined> {
  return [join(home, '.bitori'), join(workDir, '.bitori'), workDir].map(directory =>
    INSTRUCTION_FILENAMES.map(name => join(directory, name)).find(existsSync),
  );
}

/** 用户级 → 项目 .bitori → 项目根；项目内容靠后覆盖通用说明。 */
export function discoverInstructions(workDir: string, homeDirectory = homedir()): InstructionSource[] {
  const sources: InstructionSource[] = [];
  const projectRoot = resolve(workDir);
  const userRoot = resolve(join(homeDirectory, '.bitori'));
  for (const [index, path] of candidates(projectRoot, resolve(homeDirectory)).entries()) {
    if (!path) continue;
    sources.push({path, content: expandIncludes(path, index === 0 ? userRoot : projectRoot, new Set(), 0)});
  }
  return sources;
}

export function loadInstructions(workDir: string, homeDirectory = homedir()): string {
  return discoverInstructions(workDir, homeDirectory).map(source => `<!-- 来自 ${source.path} -->\n${source.content}`).join('\n\n');
}
