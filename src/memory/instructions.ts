import {existsSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';

const MAX_INCLUDE_DEPTH = 5;
export const INSTRUCTION_FILENAMES = ['BITORI.md', 'Bitori.md', 'bitori.md'] as const;

export interface InstructionSource {path: string; content: string}

function safeIncludePath(workDir: string, base: string, include: string): string {
  const raw = include.trim().replace(/^["']|["']$/g, '');
  const path = isAbsolute(raw) ? raw : resolve(dirname(base), raw);
  const root = resolve(workDir);
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`@include 路径越界：${include}`);
  return path;
}

function expandIncludes(path: string, workDir: string, visited: Set<string>, depth: number): string {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error(`@include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层`);
  const canonical = resolve(path);
  if (visited.has(canonical)) return '';
  visited.add(canonical);
  return readFileSync(canonical, 'utf8').replace(/@(?:include|import)\s+([^\n]+)/g, (_match, include: string) => {
    const target = safeIncludePath(workDir, canonical, include);
    if (!existsSync(target)) return `<!-- @include 未找到：${include.trim()} -->`;
    return expandIncludes(target, workDir, visited, depth + 1);
  });
}

function candidates(workDir: string, home: string): string[] {
  return [
    join(home, '.bitori', 'BITORI.md'),
    join(workDir, '.bitori', 'BITORI.md'),
    join(workDir, 'BITORI.md'),
  ];
}

/** 用户级 → 项目 .bitori → 项目根；项目内容靠后覆盖通用说明。 */
export function discoverInstructions(workDir: string, homeDirectory = process.env.HOME ?? ''): InstructionSource[] {
  const sources: InstructionSource[] = [];
  for (const path of candidates(resolve(workDir), resolve(homeDirectory))) {
    if (!existsSync(path)) continue;
    sources.push({path, content: expandIncludes(path, resolve(workDir), new Set(), 0)});
  }
  return sources;
}

export function loadInstructions(workDir: string, homeDirectory = process.env.HOME ?? ''): string {
  return discoverInstructions(workDir, homeDirectory).map(source => `<!-- 来自 ${source.path} -->\n${source.content}`).join('\n\n');
}
