import {describe, expect, it} from 'vitest';
import {StreamCollector} from '../../../src/agent/stream-collector.js';
import {ToolPolicy} from '../../../src/agent/tool-policy.js';
import {ToolRegistry} from '../../../src/tools/registry.js';
import type {StreamEvent} from '../../../src/providers/types.js';

async function collect(collector: StreamCollector, stream: AsyncIterable<StreamEvent>, signal: AbortSignal) {
  const generator = collector.collect({runId: 'r', sessionId: 's', iterationId: 'i', iteration: 1, stream, toolPolicy: new ToolPolicy(new ToolRegistry(), 'execute'), signal});
  while (true) { const step = await generator.next(); if (step.done) return step.value; }
}

describe('StreamCollector', () => {
  it('被中止时流里的异常不算供应商错误', async () => {
    const abort = new AbortController();
    const stream: AsyncIterable<StreamEvent> = {
      async *[Symbol.asyncIterator]() {
        abort.abort();
        throw new Error('内部异常');
      },
    };
    const collector = new StreamCollector();
    const result = await collect(collector, stream, abort.signal);
    expect(result.error).toBeNull();
    expect(result.cancelled).toBe(true);
  });

  it('未中止时的异常仍然记为供应商错误', async () => {
    const abort = new AbortController();
    const stream: AsyncIterable<StreamEvent> = {
      async *[Symbol.asyncIterator]() {
        throw new Error('网络断了');
      },
    };
    const collector = new StreamCollector();
    const result = await collect(collector, stream, abort.signal);
    expect(result.error).toMatchObject({code: 'provider_error', message: '网络断了'});
    expect(result.cancelled).toBe(false);
  });
});
