import type {StreamEvent} from '../../src/providers/types.js';

type Pending = {resolve: (value: IteratorResult<StreamEvent>) => void; reject: (reason: unknown) => void};

/** [s03] 测试专用的手动推进模型流。 */
export class ControlledStream implements AsyncIterable<StreamEvent> {
  readonly #queue: StreamEvent[] = [];
  readonly #waiters: Pending[] = [];
  #ended = false;
  #failure: unknown;

  push(event: StreamEvent): void {
    if (this.#ended || this.#failure) throw new Error('受控流已经结束');
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({done: false, value: event}); else this.#queue.push(event);
  }

  end(): void { this.#ended = true; this.#drain(); }
  fail(error: unknown): void { this.#failure = error; this.#drain(); }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {next: async () => {
      const value = this.#queue.shift();
      if (value) return {done: false, value};
      if (this.#failure) throw this.#failure instanceof Error ? this.#failure : new Error('受控流失败');
      if (this.#ended) return {done: true, value: undefined};
      return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => this.#waiters.push({resolve, reject}));
    }};
  }

  #drain(): void {
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#failure) waiter.reject(this.#failure); else waiter.resolve({done: true, value: undefined});
    }
  }
}
