import {describe, expect, it} from 'vitest';
import {normalizeProviderError} from '../../../src/providers/errors.js';
import type {ProviderProfile} from '../../../src/config/types.js';

const profile: ProviderProfile = {
  name: 'test', protocol: 'openai-chat', model: 'model', baseUrl: 'https://example.com',
  apiKey: 'top-secret', thinking: {type: 'disabled'},
};

describe('normalizeProviderError', () => {
  it.each([[401, 'authentication'], [429, 'rate_limit'], [500, 'provider_error']] as const)(
    '映射 %s', (status, code) => expect(normalizeProviderError({status, message: 'failure'}, profile).code).toBe(code),
  );
  it('清理密钥', () => {
    expect(normalizeProviderError({status: 401, message: 'bad top-secret'}, profile).message).not.toContain('top-secret');
  });
});
