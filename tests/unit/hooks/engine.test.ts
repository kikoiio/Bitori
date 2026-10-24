import {describe, expect, it} from 'vitest';
import {evaluateCondition, HookEngine, validateHooks} from '../../../src/hooks/engine.js';
import type {HookConfig} from '../../../src/hooks/types.js';

describe('Hook 系统', () => {
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
  });

  it('执行 command、变量替换、once 与拦截', async () => {
    const engine = new HookEngine([
      {id: 'once', event: 'startup', once: true, action: {type: 'command', command: 'echo $EVENT'}},
      {event: 'pre_tool_use', condition: '$TOOL_ARGS.file_path =~ /[.]json$/', reject: true, action: {type: 'command', command: 'echo blocked $TOOL_ARGS.file_path'}},
    ]);
    await expect(engine.fire('startup')).resolves.toHaveLength(1);
    await expect(engine.fire('startup')).resolves.toEqual([]);
    await expect(engine.firePreToolHooks('write_file', {file_path: '/tmp/a.json'})).resolves.toEqual({rejected: true, reason: 'blocked /tmp/a.json'});
    await expect(engine.firePreToolHooks('write_file', {file_path: '/tmp/a.ts'})).resolves.toMatchObject({rejected: false});
  });

  it('prompt 动作进入通知队列', async () => {
    const engine = new HookEngine([{event: 'post_receive', action: {type: 'prompt', prompt: '请记住 $MESSAGE'}}]);
    await engine.fire('post_receive', {event: 'post_receive', message: '结果'});
    expect(engine.drainNotifications()).toEqual(['请记住 结果']);
    expect(engine.drainNotifications()).toEqual([]);
  });
});
