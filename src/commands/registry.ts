import type {PermissionTier} from '../tools/permission-engine.js';

export type LocalCommandAction = 'help' | 'plan' | 'do' | 'compact' | 'permission';

export interface CommandContext {workDir: string; args: string}
interface CommandBase {
  name: string;
  aliases: string[];
  description: string;
}
export type Command = CommandBase & (
  | {type: 'local'; action: LocalCommandAction}
  | {type: 'prompt'; handler: (context: CommandContext) => string}
);

export interface ParsedCommand {name: string; args: string}

const localCommands = [
  {name: 'help', aliases: ['h', '?'], description: '显示可用命令'},
  {name: 'plan', aliases: [], description: '切换到计划模式'},
  {name: 'do', aliases: [], description: '执行最近计划'},
  {name: 'compact', aliases: ['c'], description: '手动压缩上下文'},
  {name: 'permission', aliases: ['permissions', 'mode'], description: '切换权限档：strict、default 或 bypass'},
] as const;

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  return {name: match?.[1] ?? '', args: match?.[2]?.trim() ?? ''};
}

export function permissionTierArgument(value: string): PermissionTier | undefined {
  return new Map<string, PermissionTier>([['strict', 'strict'], ['严格', 'strict'], ['default', 'default'], ['默认', 'default'], ['bypass', 'bypass'], ['放行', 'bypass']]).get(value);
}

/** 内置与用户命令统一注册；名称和别名都不可冲突。 */
export class CommandRegistry {
  readonly #commands = new Map<string, Command>();
  readonly #aliases = new Map<string, string>();

  register(command: Command): void {
    if (this.find(command.name)) throw new Error(`命令冲突：${command.name}`);
    for (const alias of command.aliases) if (this.find(alias)) throw new Error(`命令别名冲突：${alias}`);
    this.#commands.set(command.name, command);
    for (const alias of command.aliases) this.#aliases.set(alias, command.name);
  }

  registerIfAbsent(command: Command): boolean {
    if (this.find(command.name) || command.aliases.some(alias => this.find(alias))) return false;
    this.register(command);
    return true;
  }

  find(name: string): Command | undefined {
    const primary = this.#commands.get(name) ?? this.#commands.get(this.#aliases.get(name) ?? '');
    return primary ?? undefined;
  }

  complete(prefix: string): Command[] {
    const lower = prefix.toLowerCase();
    return this.listCommands().filter(command => command.name.toLowerCase().startsWith(lower) || command.aliases.some(alias => alias.toLowerCase().startsWith(lower)));
  }

  listCommands(): Command[] { return [...this.#commands.values()].sort((a, b) => a.name.localeCompare(b.name)); }
}

export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of localCommands) {
    registry.register({...command, aliases: [...command.aliases], type: 'local', action: command.name});
  }
  return registry;
}
