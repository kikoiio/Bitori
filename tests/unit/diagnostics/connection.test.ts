import {describe, expect, it} from 'vitest';
import {modelsEndpoint, probeProfile} from '../../../src/diagnostics/connection.js';
import {qoderFixtureJson} from '../../helpers/qoder-harness.js';
import type {ProviderProfile} from '../../../src/config/types.js';

function profile(protocol: ProviderProfile['protocol'], baseUrl = 'https://example.test', model = 'some-model'): ProviderProfile {
  return {name: 'probe', protocol, model, baseUrl, apiKey: 'sk-test-key', thinking: {type: 'disabled'}};
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}}));
}

describe('modelsEndpoint', () => {
  it('每个协议给出明确端点', () => {
    expect(modelsEndpoint(profile('qoder', 'https://api.qoder.com.cn'))).toEqual(expect.objectContaining({url: 'https://api.qoder.com.cn/api/v1/cloud/models'}));
    // Anthropic 的模型列表在 /v1/models，和官方 SDK 一致。
    expect(modelsEndpoint(profile('anthropic'))).toEqual(expect.objectContaining({url: 'https://example.test/v1/models'}));
    expect(modelsEndpoint(profile('openai-chat'))).toEqual(expect.objectContaining({url: 'https://example.test/models'}));
    expect(modelsEndpoint(profile('openai-responses'))).toEqual(expect.objectContaining({url: 'https://example.test/models'}));
  });
  it('anthropic 请求带版本头并用 x-api-key 认证', () => {
    const target = modelsEndpoint(profile('anthropic'));
    if ('headers' in target) {
      expect(target.headers['anthropic-version']).toBe('2023-06-01');
      // 官方 SDK 用 x-api-key；用 Bearer 探测会被网关判成未登录而误报连接失败。
      expect(target.headers['x-api-key']).toBe('sk-test-key');
      expect(target.headers['Authorization']).toBeUndefined();
    } else throw new Error('unexpected');
  });
  it('OpenAI 兼容协议仍用 Bearer 认证', () => {
    const target = modelsEndpoint(profile('openai-chat'));
    if ('headers' in target) expect(target.headers['Authorization']).toBe('Bearer sk-test-key');
    else throw new Error('unexpected');
  });
});

describe('probeProfile', () => {
  it('真实 Qoder 模型目录 fixture：识别展示名并标记可用性', async () => {
    const catalog = qoderFixtureJson('models.json');
    const result = await probeProfile(profile('qoder', 'https://api.qoder.com.cn', 'DeepSeek-Flash'), () => jsonResponse(catalog));
    expect(result.ok).toBe(true);
    expect(result.modelAvailable).toBe(true);
    expect(result.models?.length).toBeGreaterThan(5);
  });
  it('模型 ID 与配置名以相同规则忽略连接符', async () => {
    const result = await probeProfile(profile('openai-chat', 'https://example.test', 'test-model'), () => jsonResponse({data: [{id: 'test-model'}]}));
    expect(result.modelAvailable).toBe(true);
  });
  it('配置的模型不在列表 → modelAvailable false 并给出指引', async () => {
    const catalog = qoderFixtureJson('models.json');
    const result = await probeProfile(profile('qoder', 'https://api.qoder.com.cn', 'GPT-99'), () => jsonResponse(catalog));
    expect(result.ok).toBe(true);
    expect(result.modelAvailable).toBe(false);
    expect(result.guidance).toContain('模型');
  });
  it('401 区分凭据错误', async () => {
    const result = await probeProfile(profile('openai-chat'), () => jsonResponse({error: {message: 'Invalid API key'}}, 401));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('authentication');
    expect(result.guidance).toContain('API Key');
  });
  it('404 页面(HTML)判定协议/端点不匹配', async () => {
    const result = await probeProfile(profile('openai-chat'), async () => new Response('<html>404</html>', {status: 404}));
    expect(result.error?.code).toBe('protocol_mismatch');
  });
  it('DNS/连接失败归类 network', async () => {
    const result = await probeProfile(profile('openai-chat'), async () => { throw Object.assign(new Error('fetch failed: getaddrinfo ENOTFOUND example.test'), {name: 'TypeError'}); });
    expect(result.error?.code).toBe('network');
    expect(result.guidance).toContain('网络');
  });
  it('端点成功但没有模型列表时如实说明', async () => {
    const result = await probeProfile(profile('openai-chat'), () => jsonResponse({data: []}));
    expect(result.ok).toBe(true);
    expect(result.note).toContain('不提供可用模型列表');
  });
  it('探测输出永不包含密钥', async () => {
    const result = await probeProfile(profile('openai-chat'), () => jsonResponse({error: {message: 'wrong key sk-test-key provided'}}, 401));
    expect(JSON.stringify(result)).not.toContain('sk-test-key');
  });
});
