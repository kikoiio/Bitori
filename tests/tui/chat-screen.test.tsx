import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import {Message} from '../../src/tui/components/message.js';
import type {StoredMessage} from '../../src/storage/types.js';
import {ChatScreen} from '../../src/tui/screens/chat-screen.js';
import {initialAppState} from '../../src/chat/state.js';
import type {ChatController} from '../../src/chat/agent-controller.js';

const message: StoredMessage = {id: 'm', sessionId: 's', role: 'assistant', content: '中文\n```ts\nconst x = 1\n```',
  thinking: '分析', status: 'completed', errorCode: null, errorMessage: null, usage: null, providerState: null,
  createdAt: 1, updatedAt: 1};

describe('Message', () => {
  it('保留 Unicode、换行并支持 thinking 展开', () => {
    const view = render(<Message message={message} selected thinkingExpanded />);
    expect(view.lastFrame()).toContain('中文');
    expect(view.lastFrame()).toContain('const x = 1');
    expect(view.lastFrame()).toContain('分析');
    view.unmount();
  });
});

describe('ChatScreen 工具审批键盘优先级', () => {
  it.each([['y', 'approved'], ['n', 'denied']] as const)('%s 只解析为审批决定，不进入普通输入', async (key, decision) => { const resolveToolApproval = vi.fn(); const sendMessage = vi.fn(); const cancelActiveRequest = vi.fn(); const controller = {resolveToolApproval, sendMessage, cancelActiveRequest} as unknown as ChatController; const state = {...initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'}), requestStatus: 'approving' as const, approvalPrompt: {callId: 'c', toolName: 'run_command', effect: 'command' as const, argumentSummary: '{"command":"echo x"}', riskMessage: '批准的命令可能访问网络、启动子进程或影响工作区外资源。'}}; const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />); view.stdin.write(key); await new Promise(resolve => setTimeout(resolve, 20)); expect(resolveToolApproval).toHaveBeenCalledWith(decision); expect(sendMessage).not.toHaveBeenCalled(); expect(view.lastFrame()).toContain('访问网络'); view.unmount(); });
  it('Ctrl+C 在审批/执行状态取消回合而不退出', async () => { const cancelActiveRequest = vi.fn().mockResolvedValue(undefined); const onExit = vi.fn(); const controller = {cancelActiveRequest} as unknown as ChatController; const state = {...initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'}), requestStatus: 'executing_tools' as const}; const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={onExit} />); view.stdin.write('\x03'); await new Promise(resolve => setTimeout(resolve, 20)); expect(cancelActiveRequest).toHaveBeenCalledOnce(); expect(onExit).not.toHaveBeenCalled(); view.unmount(); });
});

describe('ChatScreen 异步操作', () => {
  const state = initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'});
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));

  it('等待新建会话时忽略重复操作，并在失败后允许重试', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const createSession = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(undefined);
    const listSessions = vi.fn().mockResolvedValue([]);
    const controller = {createSession, listSessions} as unknown as ChatController;
    const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('\x0e');
    await tick();
    view.stdin.write('\x0e');
    view.stdin.write('\x0f');
    await tick();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(listSessions).not.toHaveBeenCalled();
    rejectFirst?.(new Error('数据库不可用'));
    await tick();
    expect(view.lastFrame()).toContain('数据库不可用');
    view.stdin.write('\x0e');
    await tick();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()).not.toContain('数据库不可用');
    view.unmount();
  });

  it('列表与切换失败留在界面，后续仍可操作', async () => {
    const listSessions = vi.fn().mockRejectedValueOnce(new Error('列表失败'))
      .mockResolvedValue([{id: 'one', title: '会话一', updatedAt: 1}]);
    const switchSession = vi.fn().mockRejectedValueOnce(new Error('切换失败')).mockResolvedValue(undefined);
    const controller = {listSessions, switchSession} as unknown as ChatController;
    const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('\x0f');
    await tick();
    expect(view.lastFrame()).toContain('列表失败');
    view.stdin.write('\x0f');
    await tick();
    expect(view.lastFrame()).toContain('会话一');
    view.stdin.write('\r');
    await tick();
    expect(view.lastFrame()).toContain('切换失败');
    expect(view.lastFrame()).toContain('会话一');
    view.stdin.write('\r');
    await tick();
    expect(switchSession).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()).not.toContain('会话一');
    view.unmount();
  });

  it('发送失败被捕获，之后可以继续发送', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('发送失败')).mockResolvedValue(undefined);
    const controller = {sendMessage} as unknown as ChatController;
    const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('hello');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(view.lastFrame()).toContain('发送失败');
    view.stdin.write('again');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith('again');
    view.unmount();
  });

  it('切换会话未完成时阻止重复切换和新建', async () => {
    let finish: (() => void) | undefined;
    const switchSession = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const createSession = vi.fn().mockResolvedValue(undefined);
    const listSessions = vi.fn().mockResolvedValue([{id: 'one', title: '会话一', updatedAt: 1}]);
    const controller = {listSessions, switchSession, createSession} as unknown as ChatController;
    const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('\x0f');
    await tick();
    view.stdin.write('\r');
    await tick();
    view.stdin.write('\r');
    view.stdin.write('\x0e');
    await tick();
    expect(switchSession).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    finish?.();
    await tick();
    view.stdin.write('\x0e');
    await tick();
    expect(createSession).toHaveBeenCalledOnce();
    view.unmount();
  });
});
