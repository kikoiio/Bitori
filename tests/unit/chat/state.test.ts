import {describe, expect, it} from 'vitest';
import {initialAppState} from '../../../src/chat/state.js';

describe('initialAppState', () => {
  it('profile 为空时进入选择页且不含密钥', () => {
    const state = initialAppState();
    expect(state.screen).toBe('profile_select');
    expect(JSON.stringify(state)).not.toContain('apiKey');
  });
});
