import type {Instance} from 'ink';

/** [s01] 对 Ink 实例做一层生命周期包装，确保 unmount 最多执行一次。 */
export class TerminalSession {
  readonly #instance: Instance;
  #unmounted = false;

  public constructor(instance: Instance) { this.#instance = instance; }
  public waitUntilExit(): Promise<unknown> { return this.#instance.waitUntilExit(); }
  public unmount(): void {
    if (this.#unmounted) return;
    this.#unmounted = true;
    this.#instance.unmount();
  }
}
