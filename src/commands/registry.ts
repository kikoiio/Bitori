export type CommandType = 'local' | 'prompt';

export interface CommandContext {workDir: string; args: string}
export interface Command {
  name: string;
  aliases: string[];
  type: CommandType;
  description: string;
  handler: (context: CommandContext) => string;
}

export interface ParsedCommand {name: string; args: string}

export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? {name: trimmed, args: ''} : {name: trimmed.slice(0, space), args: trimmed.slice(space + 1).trim()};
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
  registry.register({name: 'help', aliases: ['h', '?'], type: 'local', description: '显示可用命令', handler: () => ''});
  registry.register({name: 'plan', aliases: [], type: 'local', description: '切换到计划模式', handler: () => '/plan'});
  registry.register({name: 'do', aliases: [], type: 'local', description: '执行最近计划', handler: () => '/do'});
  registry.register({name: 'compact', aliases: ['c'], type: 'local', description: '手动压缩上下文', handler: () => '/compact'});
  return registry;
}
