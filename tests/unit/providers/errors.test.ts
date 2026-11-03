import {describe, expect, it} from 'vitest';
import {normalizeProviderError, providerErrorGuidance, type ProviderErrorCode} from '../../../src/providers/errors.js';
import {qoderFixtureJson} from '../../helpers/qoder-harness.js';
import type {ProviderProfile} from '../../../src/config/types.js';

const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'top-secret', thinking: {type: 'disabled'},
};

const busyBody = qoderFixtureJson('busy-409.json');
const conflictBody = qoderFixtureJson('agent-version-conflict-409.json');
const busyMessage = (busyBody.error as {message: string}).message;
const conflictMessage = (conflictBody.error as {message: string}).message;

describe('normalizeProviderError', () => {
  it.each([[401, 'authentication'], [429, 'rate_limit'], [500, 'provider_error']] as const)(
    '映射 %s', (status, code) => expect(normalizeProviderError({status, message: 'failure'}, profile).code).toBe(code),
  );
  it('清理密钥', () => {
    expect(normalizeProviderError({status: 401, message: 'bad top-secret'}, profile).message).not.toContain('top-secret');
  });
  it('真实 busy 409 录制 → session_busy,不自动重试', () => {
    const error = normalizeProviderError({status: 409, message: busyMessage}, profile);
    expect(error.code).toBe('session_busy');
    expect(error.retryable).toBe(false);
  });
  it('真实 model 400 拒绝 → model_not_found', () => {
    expect(normalizeProviderError({status: 400, message: "Field 'model' must reference an available model."}, profile).code).toBe('model_not_found');
  });
  it('agent 版本冲突 409 → provider_error(可重试,由 provider 内部先重取版本)', () => {
    const error = normalizeProviderError({status: 409, message: conflictMessage}, profile);
    expect(error.code).toBe('provider_error');
    expect(error.retryable).toBe(true);
  });
  it('providerCode 优先于文本猜测', () => {
    const error = normalizeProviderError({status: 502, message: 'whatever', providerCode: 'unsupported_action'}, profile);
    expect(error.code).toBe('unsupported_action');
  });
  it('每个错误码都有可操作指引', () => {
    const codes: ProviderErrorCode[] = ['authentication', 'rate_limit', 'network', 'context_limit', 'invalid_request', 'provider_error', 'session_busy', 'model_not_found', 'unsupported_action', 'protocol_mismatch', 'unknown'];
    for (const code of codes) {
      expect(providerErrorGuidance(code).length, code).toBeGreaterThan(4);
    }
  });
});
