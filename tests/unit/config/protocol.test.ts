import {describe, expect, it} from 'vitest';
import {inferProtocol, parseProtocolHint} from '../../../src/config/protocol.js';

describe('接口方言推断', () => {
  it('Qoder PAT 前缀与地址都能认出 qoder', () => {
    expect(inferProtocol({apiKey: 'pt-abcdef', baseUrl: 'https://api.qoder.com.cn'})).toMatchObject({protocol: 'qoder', confidence: 'strong'});
    expect(inferProtocol({apiKey: 'sk-x', baseUrl: 'https://api.qoder.com.cn'})).toMatchObject({protocol: 'qoder', confidence: 'strong'});
  });

  it('地址里的 anthropic/claude 判为 Anthropic 方言', () => {
    expect(inferProtocol({baseUrl: 'https://api.scnet.cn/api/llm/anthropic'})).toMatchObject({protocol: 'anthropic', confidence: 'strong'});
    expect(inferProtocol({baseUrl: 'https://api.anthropic.com'})).toMatchObject({protocol: 'anthropic', confidence: 'strong'});
    expect(inferProtocol({baseUrl: 'https://gateway.example/claude/v1'})).toMatchObject({protocol: 'anthropic', confidence: 'strong'});
  });

  it('地址里的 responses 与 chat/completions 各自对应一种方言', () => {
    expect(inferProtocol({baseUrl: 'https://api.example/v1/responses'})).toMatchObject({protocol: 'openai-responses', confidence: 'strong'});
    expect(inferProtocol({baseUrl: 'https://api.example/v1/chat/completions'})).toMatchObject({protocol: 'openai-chat', confidence: 'strong'});
  });

  it('认不出时按 OpenAI 兼容兜底，并说明这是兜底、给出备选', () => {
    const guess = inferProtocol({baseUrl: 'https://openrouter.ai/api/v1'});
    expect(guess.protocol).toBe('openai-chat');
    expect(guess.confidence).toBe('weak');
    expect(guess.reason).toContain('最常见');
    expect(guess.alternatives).toContain('anthropic');
    expect(guess.alternatives).toContain('openai-responses');
  });

  it('空的连接参数也能给出兜底结论', () => {
    expect(inferProtocol({})).toMatchObject({protocol: 'openai-chat', confidence: 'weak'});
  });

  it('协议提示只认受支持的方言', () => {
    expect(parseProtocolHint('anthropic')).toBe('anthropic');
    expect(parseProtocolHint('openai-chat')).toBe('openai-chat');
    expect(parseProtocolHint(' gemini ')).toBeUndefined();
    expect(parseProtocolHint('')).toBeUndefined();
    expect(parseProtocolHint(undefined)).toBeUndefined();
  });
});
