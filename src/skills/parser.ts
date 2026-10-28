import {readFileSync} from 'node:fs';
import type {SkillMeta} from './types.js';

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

/** 解析元数据并记录当前不能执行的选项，供激活时拒绝。 */
export function parseSkillText(text: string): ParsedSkill {
  const {values, body} = splitFrontmatter(text);
  const name = values.get('name');
  if (!name) throw new Error('Skill 缺少 name');
  const unsupportedFields = ['allowed-tools', 'fork-context', 'model'].filter(field => values.has(field));
  if (values.has('mode') && values.get('mode') !== 'inline') unsupportedFields.push('mode');
  return {
    meta: {
      name,
      description: values.get('description') ?? '',
      unsupportedFields,
    },
    body,
  };
}

export function parseSkillFile(path: string): ParsedSkill { return parseSkillText(readFileSync(path, 'utf8')); }
