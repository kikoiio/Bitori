import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadConfig, resolveProfile} from '../../../src/config/loader.js';

const temporaryDirectories: string[] = [];

function home(yaml: string, environment = 'API_KEY=test-secret\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'mycode-config-'));
  temporaryDirectories.push(root);
  const directory = join(root, '.mycode');
  mkdirSync(directory);
  writeFileSync(join(directory, 'config.yaml'), yaml);
  writeFileSync(join(directory, '.env'), environment);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('loadConfig', () => {
  it('只从固定目录加载多个 profile', () => {
    const root = home(`profiles:
  - name: one
    protocol: anthropic
    model: claude
    base_url: https://example.com
    api_key: \${API_KEY}
    thinking: true
  - name: two
    protocol: openai-responses
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`);
    const config = loadConfig(root);
    expect(config.profiles).toHaveLength(2);
    expect(config.profiles[0]?.apiKey).toBe('test-secret');
    expect(resolveProfile(config)).toBeNull();
    expect(resolveProfile(config, 'two')?.name).toBe('two');
  });

  it('单 profile 自动选择', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`);
    expect(resolveProfile(loadConfig(root))?.name).toBe('one');
  });

  it('缺失文件、变量和未知 profile 给出安全错误', () => {
    expect(() => loadConfig(join(tmpdir(), 'does-not-exist'))).toThrow(/config\.yaml/);
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${MISSING}
`);
    expect(() => loadConfig(root)).toThrow(/MISSING/);
    expect(() => resolveProfile(loadConfig(home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`)), 'missing')).toThrow(/missing/);
  });
});
