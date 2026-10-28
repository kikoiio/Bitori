import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {CommandRegistry} from './registry.js';

export interface UserCommandFrontmatter {description: string; argumentHint: string}

function frontmatter(text: string): {meta: UserCommandFrontmatter; body: string} {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const values = new Map<string, string>();
  if (match) for (const line of match[1]!.split('\n')) {
    const index = line.indexOf(':');
    if (index > 0) values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return {
    meta: {description: values.get('description') ?? '', argumentHint: values.get('argument-hint') ?? ''},
    body: text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(),
  };
}

/** $ARGUMENTS 支持内联替换；无占位时参数追加到末尾。 */
export function renderBody(body: string, args: string): string {
  return body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args) : args ? `${body}\n\n${args}` : body;
}

/** 扫描用户级与项目级 commands 目录；子目录形成 namespace。 */
export function loadUserCommands(workDir: string, homeDirectory = homedir(), registry = new CommandRegistry()): CommandRegistry {
  const roots = [join(homeDirectory, '.bitori', 'commands'), join(workDir, '.bitori', 'commands')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        const namespace = entry.name;
        for (const file of readdirSync(join(root, namespace)).filter(name => name.endsWith('.md'))) {
          registerMarkdown(registry, join(root, namespace, file), `${namespace}/${file.replace(/\.md$/, '')}`);
        }
      } else if (entry.name.endsWith('.md')) registerMarkdown(registry, join(root, entry.name), entry.name.replace(/\.md$/, ''));
    }
  }
  return registry;
}

function registerMarkdown(registry: CommandRegistry, path: string, name: string): void {
  const parsed = frontmatter(readFileSync(path, 'utf8'));
  registry.registerIfAbsent({
    name,
    aliases: [],
    type: 'prompt',
    description: parsed.meta.description,
    handler: ({args}) => renderBody(parsed.body, args),
  });
}
