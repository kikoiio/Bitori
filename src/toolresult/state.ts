/** 工具结果替换决策账本；决策一旦写入就冻结，保证每轮请求前缀逐字节稳定。 */
export class ToolResultReplacementState {
  readonly #seenIds = new Set<string>();
  readonly #replacements = new Map<string, string>();

  record(toolUseId: string, original: string, replaced: string): void {
    this.#seenIds.add(toolUseId);
    if (original !== replaced) this.#replacements.set(toolUseId, replaced);
  }

  has(toolUseId: string): boolean { return this.#seenIds.has(toolUseId); }
  getReplacement(toolUseId: string): string | undefined { return this.#replacements.get(toolUseId); }
  get size(): number { return this.#seenIds.size; }
}
