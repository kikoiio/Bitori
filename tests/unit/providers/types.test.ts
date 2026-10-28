import {describe, expect, it} from 'vitest';
import {anthropicReplayPayloadSchema, isProviderState} from '../../../src/providers/types.js';

describe('ProviderState 存储边界', () => {
  it('兼容 Responses 的不透明旧载荷', () => {
    expect(isProviderState({protocol: 'openai-responses', payload: [{type: 'reasoning'}]})).toBe(true);
    expect(isProviderState({protocol: 'openai-responses', payload: '旧载荷'})).toBe(true);
  });

  it('校验 Anthropic 必需字段，保留空思考、扩展字段和不透明块', () => {
    const payload = [
      {type: 'thinking', thinking: '', signature: 'signed', extension: {opaque: 'value'}},
      {type: 'redacted_thinking', data: 'encrypted'},
      {type: 'text', text: '', citations: null},
      {type: 'tool_use', id: 'p', name: 'tool', input: {nested: [true, null]}},
      {type: 'server_tool_use', id: 'server-1', input: {query: 'test'}},
    ];
    expect(anthropicReplayPayloadSchema.parse(payload)).toEqual(payload);
    const state: unknown = JSON.parse(JSON.stringify({protocol: 'anthropic', payload}));
    expect(isProviderState(state)).toBe(true);
  });

  it.each<unknown>([null, {}, {protocol: 'other', payload: []}, {protocol: 'anthropic'},
    ...[[], 'bad', [null], [{type: 'thinking', thinking: '无签名'}], [{type: 'thinking', thinking: '', signature: ''}],
      [{type: 'redacted_thinking', data: 1}], [{type: 'text', text: 1}],
      [{type: 'tool_use', id: 'p', name: 'tool', input: []}], [{type: ''}],
    ].map(payload => ({protocol: 'anthropic', payload})),
  ])('拒绝损坏的协议状态 %j', state => {
    expect(isProviderState(state)).toBe(false);
  });
});
