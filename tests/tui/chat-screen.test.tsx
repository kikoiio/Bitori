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
  it.each([['y', 'approved'], ['n', 'denied'], ['1', 'approved'], ['4', 'denied']] as const)('%s 只解析为审批决定，不进入普通输入', async (key, decision) => { const resolveToolApproval = vi.fn(); const sendMessage = vi.fn(); const cancelActiveRequest = vi.fn(); const controller = {resolveToolApproval, sendMessage, cancelActiveRequest} as unknown as ChatController; const state = {...initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'}), requestStatus: 'approving' as const, approvalPrompt: {callId: 'c', toolName: 'run_command', effect: 'command' as const, argumentSummary: '{"command":"echo x"}', riskMessage: '批准的命令可能访问网络、启动子进程或影响工作区外资源。'}}; const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />); view.stdin.write(key); await new Promise(resolve => setTimeout(resolve, 20)); expect(resolveToolApproval).toHaveBeenCalledWith(decision); expect(sendMessage).not.toHaveBeenCalled(); expect(view.lastFrame()).toContain('访问网络'); view.unmount(); });
  it('审批卡片用上下箭头选择并用 Enter 确认', async () => {
    const resolveToolApproval = vi.fn();
    const controller = {resolveToolApproval} as unknown as ChatController;
    const state = {...initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'}), requestStatus: 'approving' as const, approvalPrompt: {callId: 'c', toolName: 'run_command', effect: 'command' as const, argumentSummary: '{"command":"echo x"}', riskMessage: null}};
    const view = render(<ChatScreen state={state} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('\u001B[B');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('❯ 2. 是，本会话允许');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resolveToolApproval).toHaveBeenCalledWith('approved_session');
    view.unmount();
  });
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
    view.stdin.write('\x13');
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
    view.stdin.write('\x13');
    await tick();
    expect(view.lastFrame()).toContain('列表失败');
    view.stdin.write('\x13');
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
    view.stdin.write('\x13');
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

describe('ChatScreen 斜杠命令与模型选择', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));

  it('输入 / 展示命令面板，/model 打开配置选择', async () => {
    const controller = {commandCatalog: () => []} as unknown as ChatController;
    const profiles = [
      {name: 'p', protocol: 'openai-chat' as const, model: 'm'},
      {name: 'q', protocol: 'anthropic' as const, model: 'm2'},
    ];
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={controller} height={30} onExit={vi.fn()} profiles={profiles} onSwitchProfile={vi.fn()} />);
    view.stdin.write('/');
    await tick();
    expect(view.lastFrame()).toContain('/model');
    expect(view.lastFrame()).toContain('切换模型配置');
    view.stdin.write('model');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(view.lastFrame()).toContain('选择模型配置');
    expect(view.lastFrame()).toContain('q');
    expect(view.lastFrame()).toContain('m2');
    view.unmount();
  });
});

describe('ChatScreen 工具视图', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 25));

  it('Ctrl+O 切换详细工具记录提示', async () => {
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={{} as ChatController} height={24} onExit={vi.fn()} />);
    expect(view.lastFrame()).not.toContain('工具详情已展开');
    view.stdin.write('\x0f');
    await tick();
    expect(view.lastFrame()).toContain('工具详情已展开 · Ctrl+O 切换');
    view.stdin.write('\x0f');
    await tick();
    expect(view.lastFrame()).not.toContain('工具详情已展开');
    view.unmount();
  });

  it('/diff 打开侧栏且不发给模型', async () => {
    const sendMessage = vi.fn();
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={{sendMessage} as unknown as ChatController} height={24} onExit={vi.fn()} />);
    view.stdin.write('/diff');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain('改动 · 本次会话');
    expect(view.lastFrame()).toContain('本次没有改动');
    view.unmount();
  });
});

describe('ChatScreen 会话搜索/重命名/删除', () => {
  const sessions = [
    {id: 's1', profileName: 'p', title: '渲染 Markdown', createdAt: 1, updatedAt: 3, agentMode: 'execute' as const, latestPlanMessageId: null},
    {id: 's2', profileName: 'p', title: '你好世界', createdAt: 1, updatedAt: 2, agentMode: 'execute' as const, latestPlanMessageId: null},
  ];
  const tick = async (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  it('输入即搜索，Esc 先清筛选再关闭', async () => {
    const listSessions = vi.fn().mockResolvedValue(sessions);
    const controller = {listSessions} as unknown as ChatController;
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('/sessions'); await tick(); view.stdin.write('\r'); await tick();
    expect(view.lastFrame()).toContain('历史会话');
    view.stdin.write('markdown'); await tick();
    expect(view.lastFrame()).toContain('渲染 Markdown');
    expect(view.lastFrame()).not.toContain('你好世界');
    view.stdin.write('\u001B'); await tick();
    expect(view.lastFrame()).toContain('你好世界');
    view.stdin.write('\u001B'); await tick();
    expect(view.lastFrame()).not.toContain('历史会话');
    view.unmount();
  });

  it('r 重命名选中会话并回读列表', async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    const listSessions = vi.fn().mockResolvedValue(sessions);
    const controller = {listSessions, renameSession} as unknown as ChatController;
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('/sessions'); await tick(); view.stdin.write('\r'); await tick();
    view.stdin.write('r'); await tick();
    expect(view.lastFrame()).toContain('新标题');
    view.stdin.write('改名成功'); await tick(); view.stdin.write('\r'); await tick();
    expect(renameSession).toHaveBeenCalledWith('s1', '改名成功');
    expect(listSessions).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('d 两步确认后删除', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const listSessions = vi.fn().mockResolvedValue(sessions);
    const controller = {listSessions, deleteSession} as unknown as ChatController;
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('/sessions'); await tick(); view.stdin.write('\r'); await tick();
    view.stdin.write('d'); await tick();
    expect(view.lastFrame()).toContain('删除「渲染 Markdown」');
    expect(deleteSession).not.toHaveBeenCalled();
    view.stdin.write('d'); await tick();
    expect(deleteSession).toHaveBeenCalledWith('s1');
    view.unmount();
  });

  it('取消一次删除确认不需要两步', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const listSessions = vi.fn().mockResolvedValue(sessions);
    const controller = {listSessions, deleteSession} as unknown as ChatController;
    const view = render(<ChatScreen state={initialAppState({name: 'p', protocol: 'openai-chat', model: 'm'})} controller={controller} height={24} onExit={vi.fn()} />);
    view.stdin.write('/sessions'); await tick(); view.stdin.write('\r'); await tick();
    view.stdin.write('d'); await tick();
    view.stdin.write('x'); await tick();
    view.stdin.write('d'); await tick();
    expect(deleteSession).not.toHaveBeenCalled();
    view.unmount();
  });
});
