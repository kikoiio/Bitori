import {describe, expect, it} from 'vitest';
import {normalizeThinking, parseConfig} from '../../../src/config/schema.js';

const base = {
  name: 'main',
  protocol: 'anthropic',
  model: 'claude',
  base_url: 'https://example.com',
  api_key: '${API_KEY}',
};

describe('config schema', () => {
  it('接受并归一化 thinking', () => {
    expect(parseConfig({profiles: [base]}).profiles).toHaveLength(1);
    expect(normalizeThinking(true)).toEqual({type: 'auto'});
    expect(normalizeThinking(false)).toEqual({type: 'disabled'});
    expect(normalizeThinking({type: 'adaptive'})).toEqual({type: 'adaptive'});
    expect(normalizeThinking({type: 'manual', budget_tokens: 4096, max_tokens: 8192})).toEqual({
      type: 'manual', budgetTokens: 4096, maxTokens: 8192,
    });
  });

  it('拒绝重复名称和非法 thinking', () => {
    expect(() => parseConfig({profiles: [base, base]})).toThrow(/重复/);
    expect(() => parseConfig({profiles: [{...base, protocol: 'openai-chat', thinking: true}]})).toThrow(/thinking/);
    expect(() => parseConfig({profiles: [{...base, thinking: {type: 'manual', budget_tokens: 1000, max_tokens: 999}}]})).toThrow();
  });

  it('拒绝非法 URL 和密钥字面量', () => {
    expect(() => parseConfig({profiles: [{...base, base_url: 'file:///x'}]})).toThrow();
    expect(() => parseConfig({profiles: [{...base, api_key: 'secret'}]})).toThrow();
  });

  it('校验两类 MCP Server 配置', () => {
    const parsed = parseConfig({profiles: [base], mcp_servers: {
      local: {transport: 'stdio', command: 'node', args: ['server.js'], env: {TOKEN: '${TOKEN}'}},
      remote: {transport: 'http', url: 'https://example.com/mcp', headers: {Authorization: 'Bearer ${TOKEN}'}},
    }});
    expect(Object.keys(parsed.mcp_servers ?? {})).toEqual(['local', 'remote']);
    expect(() => parseConfig({profiles: [base], mcp_servers: {bad: {transport: 'http', url: ''}}})).toThrow(/url/);
  });

  it('models 别名映射到 profile 名', () => {
    const parsed = parseConfig({profiles: [base], models: {haiku: 'main'}});
    expect(parsed.models).toEqual({haiku: 'main'});
  });
});
