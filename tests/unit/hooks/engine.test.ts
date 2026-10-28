import {describe, expect, it} from 'vitest';
import {evaluateCondition, HookEngine, validateHooks} from '../../../src/hooks/engine.js';
import type {HookConfig} from '../../../src/hooks/types.js';

describe('Hook 系统', () => {
  it('HTTP 超时与网络失败按失败策略拦截或放行', async () => {
    const hanging: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true});
    });
    const hook: HookConfig = {event: 'pre_tool_use', reject: true, timeoutMs: 20, action: {type: 'http', url: 'https://example.invalid'}};
    const closed = new HookEngine([hook], hanging);
    await expect(closed.guard('pre_tool_use', 'write_file', {})).resolves.toMatchObject({rejected: true});
    const open = new HookEngine([{...hook, failurePolicy: 'open'}], async () => { throw new Error('network'); });
    await expect(open.guard('pre_tool_use', 'write_file', {})).resolves.toMatchObject({rejected: false});
    const success = new HookEngine([hook], async () => new Response('blocked'));
    await expect(success.guard('pre_tool_use', 'write_file', {})).resolves.toEqual({rejected: true, reason: 'blocked'});
    const controller = new AbortController();
    const pending = closed.guard('pre_tool_use', 'write_file', {}, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({rejected: true});
    expect(validateHooks([{event: 'startup', action: {type: 'agent', prompt: 'x'}}])).toBeInstanceOf(Error);
  });
  it('条件支持四种操作符与单一逻辑组合', () => {
    const context = {event: 'pre_tool_use' as const, toolName: 'write_file', args: {file_path: '/tmp/a.json'}};
    expect(evaluateCondition('$TOOL_NAME == write_file', context)).toBe(true);
    expect(evaluateCondition('$TOOL_ARGS.file_path =~ /[.]json$/', context)).toBe(true);
    expect(evaluateCondition('$TOOL_NAME != run_command && $TOOL_ARGS.file_path =~ /[.]json$/', context)).toBe(true);
    expect(evaluateCondition('$TOOL_NAME == run_command || $TOOL_NAME == write_file', context)).toBe(true);
    expect(evaluateCondition('$TOOL_NAME == run_command && $TOOL_NAME == write_file || $EVENT == pre_tool_use', context)).toBe(false);
  });

  it('校验事件、动作必填与拦截约束', () => {
    const hook: HookConfig = {event: 'startup', action: {type: 'command', command: 'echo hi'}};
    expect(validateHooks([hook])).toBeNull();
    expect(validateHooks([{...hook, event: 'bad' as never}])).toBeInstanceOf(Error);
    expect(validateHooks([{event: 'startup', action: {type: 'command'}}])).toBeInstanceOf(Error);
    expect(validateHooks([{event: 'pre_tool_use', action: {type: 'prompt', prompt: 'x'}, async: true}])).toBeInstanceOf(Error);
    expect(validateHooks([{event: 'permission_request', action: {type: 'prompt', prompt: 'x'}, async: true}])).toBeInstanceOf(Error);
    expect(validateHooks([{event: 'pre_tool_use', action: {type: 'command', command: 'echo $TOOL_ARGS.path'}}])).toBeInstanceOf(Error);
  });

  it('执行结构化 command，动态上下文只通过环境变量传递，支持 once 与拦截', async () => {
    const engine = new HookEngine([
      {id: 'once', event: 'startup', once: true, action: {type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write(JSON.parse(process.env.BITORI_HOOK_CONTEXT).event)']}},
      {event: 'pre_tool_use', condition: '$TOOL_ARGS.file_path =~ /[.]json$/', reject: true, action: {type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("blocked " + JSON.parse(process.env.BITORI_HOOK_CONTEXT).args.file_path)']}},
    ]);
    await expect(engine.fire('startup')).resolves.toHaveLength(1);
    await expect(engine.fire('startup')).resolves.toEqual([]);
    const path = '/tmp/a & echo injected.json';
    await expect(engine.guard('pre_tool_use', 'write_file', {file_path: path})).resolves.toEqual({rejected: true, reason: `blocked ${path}`});
    await expect(engine.guard('pre_tool_use', 'write_file', {file_path: '/tmp/a.ts'})).resolves.toMatchObject({rejected: false});
  });

  it('prompt 动作进入通知队列', async () => {
    const engine = new HookEngine([{event: 'post_receive', action: {type: 'prompt', prompt: '请记住 $MESSAGE'}}]);
    await engine.fire('post_receive', {event: 'post_receive', message: '结果'});
    expect(engine.drainNotifications()).toEqual(['请记住 结果']);
    expect(engine.drainNotifications()).toEqual([]);
  });
});
