import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {BUILTIN_AGENTS, type AgentDefinition} from './types.js';

export function parseAgentDefinition(content: string): AgentDefinition | null {
  try {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return null;
    const raw = parseYaml(match[1]!) as Record<string, unknown>;
    if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    return {
      name: raw.name,
      description: typeof raw.description === 'string' ? raw.description : body.slice(0, 200),
      ...(typeof raw.system_prompt === 'string' ? {systemPromptOverride: raw.system_prompt} : {}),
      ...(typeof raw.model === 'string' ? {model: raw.model} : {}),
      unsupportedFields: ['tools', 'disallowed_tools', 'max_turns', 'permission_mode', 'background'].filter(field => Object.hasOwn(raw, field)),
      ...(body ? {initialPrompt: body} : {}),
    };
  } catch { return null; }
}

function loadDirectory(directory: string, definitions: AgentDefinition[]): void {
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory).filter(name => name.endsWith('.md')).sort()) {
    const definition = parseAgentDefinition(readFileSync(join(directory, file), 'utf8'));
    if (!definition) continue;
    const index = definitions.findIndex(item => item.name === definition.name);
    if (index >= 0) definitions[index] = definition;
    else definitions.push(definition);
  }
}

/** 内置 → 用户级 → 项目级；项目级同名完整覆盖。 */
export function loadAgentDefinitions(workDir: string, homeDirectory = homedir()): AgentDefinition[] {
  const definitions = [...BUILTIN_AGENTS];
  loadDirectory(join(homeDirectory, '.bitori', 'agents'), definitions);
  loadDirectory(join(workDir, '.bitori', 'agents'), definitions);
  return definitions;
}
