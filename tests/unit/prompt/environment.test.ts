import {describe, expect, it} from 'vitest';
import {collectEnvironment, environmentSection} from '../../../src/prompt/environment.js';
import type {ProviderProfile} from '../../../src/config/types.js';

const profile: ProviderProfile = {
  name: 'main',
  protocol: 'anthropic',
  model: 'claude-fable-5',
  baseUrl: 'https://example.com',
  apiKey: 'sk-test',
  thinking: {type: 'auto'},
};

describe('prompt environment', () => {
  it('采集六字段', () => {
    const env = collectEnvironment(profile, 'D:\\ws');
    expect(env.workspaceRoot).toBe('D:\\ws');
    expect(env.os.length).toBeGreaterThan(0);
    expect(env.nodeVersion).toMatch(/^v\d+/);
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(env.profileName).toBe('main');
    expect(env.model).toBe('claude-fable-5');
  });

  it('渲染文本包含工作区路径与模型名', () => {
    const section = environmentSection(collectEnvironment(profile, 'D:\\ws'));
    expect(section.priority).toBe(80);
    expect(section.text).toContain('D:\\ws');
    expect(section.text).toContain('claude-fable-5');
  });
});
