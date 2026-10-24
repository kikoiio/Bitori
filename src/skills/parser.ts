import {readFileSync} from 'node:fs';
import type {SkillForkContext, SkillMeta, SkillMode} from './types.js';

export interface ParsedSkill {meta: SkillMeta; body: string}

function splitFrontmatter(text: string): {values: Map<string, string>; body: string} {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const values = new Map<string, string>();
  if (!match) return {values, body: text.trim()};
  for (const line of match[1]!.split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return {values, body: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()};
}

function normalizeList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

/** [s10] 只信任显式 fork/fork-context；未知值回退 inline/none，避免手写错误破坏执行。 */
export function parseSkillText(text: string): ParsedSkill {
  const {values, body} = splitFrontmatter(text);
  const name = values.get('name');
  if (!name) throw new Error('Skill 缺少 name');
  const mode = values.get('mode') === 'fork' ? 'fork' satisfies SkillMode : 'inline';
  const context = values.get('fork-context') === 'recent' || values.get('fork-context') === 'full' ? values.get('fork-context') as SkillForkContext : 'none';
  return {
    meta: {
      name,
      description: values.get('description') ?? '',
      allowedTools: normalizeList(values.get('allowed-tools')),
      mode,
      forkContext: mode === 'fork' ? context : 'none',
      model: values.get('model') ?? null,
    },
    body,
  };
}

export function parseSkillFile(path: string): ParsedSkill { return parseSkillText(readFileSync(path, 'utf8')); }
