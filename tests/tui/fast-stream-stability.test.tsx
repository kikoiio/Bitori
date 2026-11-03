import React from 'react';
import {render} from 'ink';
import {describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatController} from '../../src/chat/agent-controller.js';
import {ChatScreen} from '../../src/tui/screens/chat-screen.js';
import {useChatController} from '../../src/tui/hooks/use-chat-controller.js';
import {SessionRepository} from '../../src/storage/repository.js';
import type {LLMClient, StreamEvent} from '../../src/providers/types.js';
import type {ProviderProfile} from '../../src/config/types.js';

const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'secret', thinking: {type: 'disabled'},
};

function Harness({controller}: {controller: ChatController}) {
  const state = useChatController(controller);
  return <ChatScreen state={state} controller={controller} height={24} onExit={() => undefined} />;
}

function fakeTerminal() {
  const chunks: string[] = [];
  return {
    chunks,
    stdout: {
      isTTY: true, columns: 80, rows: 24,
      write: (data: string) => { chunks.push(data); const end = Date.now() + 2; while (Date.now() < end) { /* 模拟真实终端写入耗时 */ } return true; },
      on: () => undefined, off: () => undefined,
    },
    stdin: {
      isTTY: true,
      setRawMode: () => undefined, setEncoding: () => undefined, resume: () => undefined, pause: () => undefined,
      read: () => null, on: () => undefined, off: () => undefined, addListener: () => undefined,
      removeListener: () => undefined, ref: () => undefined, unref: () => undefined,
    },
  };
}

describe('PromptInput 流式更新稳定性', () => {
  it('快速流式输出时保持终端输入光标稳定', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-fast-'));
    const client: LLMClient = {async *streamChat(_request, signal): AsyncIterable<StreamEvent> {
      for (let index = 0; index < 1000; index += 1) {
        if (signal.aborted) break;
        yield {type: 'text_delta', text: `片段${index} `};
        await Promise.resolve();
      }
      yield {type: 'completed', finishReason: 'stop'};
    }};
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    const terminal = fakeTerminal();
    const app = render(<Harness controller={controller} />, {stdout: terminal.stdout as never, stdin: terminal.stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true});
    await controller.sendMessage('测试');
    const status = controller.getState().requestStatus;
    const stop = controller.getState().stopReason;
    const err = controller.getState().visibleError;
    const hasMax = terminal.chunks.join('').includes('Maximum update depth');
    app.unmount();
    await controller.shutdown();
    rmSync(root, {recursive: true, force: true});
    expect({status, stop, err, hasMax}).toEqual({status: 'idle', stop: 'natural_completion', err: null, hasMax: false});
  }, 60_000);
});
