import type {LLMClient} from './types.js';

/** Limits calls into LLMClient.streamChat. SDK-internal retries/fallbacks are outside this counter. */
export class ProviderRequestLimiter {
  readonly #limit: number | undefined;
  #count = 0;
  #blockedCount = 0;

  constructor(limit?: number) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Provider 聊天请求上限必须是正整数');
    }
    this.#limit = limit;
  }

  get count(): number { return this.#count; }
  get blockedCount(): number { return this.#blockedCount; }

  wrap(client: LLMClient): LLMClient {
    const beginRequest = () => {
      if (this.#limit !== undefined && this.#count >= this.#limit) {
        this.#blockedCount++;
        throw new Error(`Provider 聊天请求达到硬上限 ${this.#limit}`);
      }
      this.#count++;
    };
    return {
      async *streamChat(request, signal) {
        beginRequest();
        yield* client.streamChat(request, signal);
      },
    };
  }
}
