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

/** 可写的假终端：让 Ink 走交互模式（交互模式才会维护真实光标）。 */
function fakeTerminal() {
  const chunks: string[] = [];
  return {
    chunks,
    stdout: {
      isTTY: true, columns: 80, rows: 24,
      write: (data: string) => { chunks.push(data); return true; },
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

describe('中断进行中的生成', () => {
  it('取消后界面回到空闲，且不把内部异常当成模型故障', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-cancel-'));
    const client: LLMClient = {async *streamChat(_request, signal): AsyncIterable<StreamEvent> {
      // 模拟真实流式输出：持续吐字，直到被中止。
      for (let index = 0; index < 500; index += 1) {
        if (signal.aborted) break;
        yield {type: 'text_delta', text: `片段${index} `};
        await new Promise<void>(resolve => { if (!signal.aborted) signal.addEventListener('abort', () => resolve(), {once: true}); setTimeout(resolve, 5); });
      }
      yield {type: 'completed', finishReason: 'stop'};
    }};
    const controller = new ChatController(client, new SessionRepository(join(root, 'db.sqlite')), null, undefined, {workspaceRoot: root});
    await controller.initialize(profile);
    const terminal = fakeTerminal();
    const app = render(<Harness controller={controller} />, {stdout: terminal.stdout as never, stdin: terminal.stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true});
    void controller.sendMessage('测试');
    await new Promise(resolve => setTimeout(resolve, 120));
    void controller.cancelActiveRequest();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(controller.getState().requestStatus).toBe('idle');
    expect(controller.getState().stopReason).toBe('user_cancelled');
    expect(terminal.chunks.join('')).not.toContain('Maximum update depth');
    app.unmount();
    await controller.shutdown();
    rmSync(root, {recursive: true, force: true});
  }, 20_000);
});
