import {describe, expect, it} from 'vitest';
import {redactSecrets} from '../../../src/config/secrets.js';
import type {ProviderProfile} from '../../../src/config/types.js';

describe('redactSecrets', () => {
  it('清理所有 profile 密钥', () => {
    const profiles = [
      {name: 'a', protocol: 'anthropic', model: 'x', baseUrl: 'https://x', apiKey: 'secret-a', thinking: {type: 'disabled'}},
      {name: 'b', protocol: 'openai-chat', model: 'y', baseUrl: 'https://y', apiKey: 'secret-b', thinking: {type: 'disabled'}},
    ] satisfies ProviderProfile[];
    expect(redactSecrets('secret-a / secret-b / secret-a', profiles)).toBe('<redacted> / <redacted> / <redacted>');
  });
});
