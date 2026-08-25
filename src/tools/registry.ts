import type {Tool, ToolDefinition} from './types.js';

/** [s02] 六个工具及后续扩展的唯一登记入口，保留注册顺序。 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`工具名称重复：${tool.name}`);
    this.#tools.set(tool.name, tool);
  }
  get(name: string): Tool | undefined { return this.#tools.get(name); }
  entries(): Tool[] { return [...this.#tools.values()]; }
  definitions(): ToolDefinition[] { return this.entries().map(({name, description, inputSchema}) => ({name, description, inputSchema})); }
}
