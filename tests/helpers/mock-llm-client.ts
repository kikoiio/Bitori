import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';

export class MockLLMClient implements LLMClient {
  public readonly requests: ChatRequest[] = [];
  readonly #scripts: Array<StreamEvent[] | ((signal: AbortSignal) => AsyncIterable<StreamEvent>)>;
  readonly #repeatSingle: boolean;

  public constructor(events: StreamEvent[] | StreamEvent[][]) {
    this.#repeatSingle = !Array.isArray(events[0]);
    this.#scripts = this.#repeatSingle ? [events as StreamEvent[]] : events as StreamEvent[][];
  }

  public async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const script = this.#repeatSingle ? this.#scripts[0] : this.#scripts[this.requests.length - 1];
    if (!script) throw new Error(`MockLLMClient 缺少第 ${this.requests.length} 次请求脚本`);
    const stream = typeof script === 'function' ? script(signal) : script;
    for await (const event of stream) {
      if (signal.aborted) return;
      await Promise.resolve();
      yield event;
    }
  }
}
