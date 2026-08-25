import {describe, expect, it} from 'vitest';
import {createToolSystem} from '../../../src/tools/create-tool-system.js';
import {ToolCallAssembler} from '../../../src/tools/call-assembler.js';

describe('ToolCallAssembler', () => {
  it('拼接交错参数并隔离损坏调用', () => {
    const assembler = new ToolCallAssembler(createToolSystem(process.cwd()).registry);
    assembler.consume({type: 'tool_call_start', internalId: 'a', providerCallId: 'pa', position: 0, name: 'read_file'});
    assembler.consume({type: 'tool_call_start', internalId: 'b', providerCallId: 'pb', position: 1, name: 'write_file'});
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'a', delta: '{"path":'});
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'b', delta: '{bad'});
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'a', delta: '"x"}'});
    assembler.consume({type: 'tool_call_end', internalId: 'a'}); assembler.consume({type: 'tool_call_end', internalId: 'b'});
    const batch = assembler.finish();
    expect(batch.validCalls[0]).toMatchObject({providerCallId: 'pa', arguments: {path: 'x'}});
    expect(batch.invalidCalls[0]?.error.code).toBe('invalid_arguments');
  });

  it('将不完整、重复开始、未知工具和 schema 错误分别闭合为失败', () => {
    const assembler = new ToolCallAssembler(createToolSystem(process.cwd()).registry);
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'missing', delta: '{}'});
    assembler.consume({type: 'tool_call_start', internalId: 'incomplete', providerCallId: null, position: 0, name: 'read_file'});
    assembler.consume({type: 'tool_call_start', internalId: 'duplicate', providerCallId: 'p1', position: 1, name: 'read_file'});
    assembler.consume({type: 'tool_call_start', internalId: 'duplicate', providerCallId: 'p2', position: 1, name: 'write_file'});
    assembler.consume({type: 'tool_call_end', internalId: 'duplicate'});
    assembler.consume({type: 'tool_call_start', internalId: 'unknown', providerCallId: 'p3', position: 2, name: 'not_a_tool'});
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'unknown', delta: '{}'});
    assembler.consume({type: 'tool_call_end', internalId: 'unknown'});
    assembler.consume({type: 'tool_call_start', internalId: 'schema', providerCallId: 'p4', position: 3, name: 'read_file'});
    assembler.consume({type: 'tool_call_arguments_delta', internalId: 'schema', delta: '{"path":42}'});
    assembler.consume({type: 'tool_call_end', internalId: 'schema'});
    const result = assembler.finish();
    expect(result.validCalls).toEqual([]);
    expect(result.invalidCalls.map(call => call.error.code)).toEqual(['invalid_arguments', 'invalid_arguments', 'unknown_tool', 'invalid_arguments']);
  });
});
