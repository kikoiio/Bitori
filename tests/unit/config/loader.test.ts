import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {collectSecretValues, loadConfig, resolveProfile, resolveProfileWithApiKey} from '../../../src/config/loader.js';

const temporaryDirectories: string[] = [];

function home(yaml: string, environment = 'API_KEY=test-secret\n'): string {
  const root = mkdtempSync(join(tmpdir(), 'bitori-config-'));
  temporaryDirectories.push(root);
  const directory = join(root, '.bitori');
  mkdirSync(directory);
  writeFileSync(join(directory, 'config.yaml'), yaml);
  writeFileSync(join(directory, '.env'), environment);
  return root;
}

function project(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bitori-project-config-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, '.bitori'));
  writeFileSync(join(root, '.bitori', 'config.yaml'), yaml);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('loadConfig', () => {
  it('工作区为用户主目录时只按用户配置解析，即使路径写法不同', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
mcp_servers:
  local:
    transport: stdio
    command: node
`);
    for (const workspace of [root, relative(process.cwd(), root), `${root}/./`]) {
      const config = loadConfig(root, workspace, {});
      expect(config.profiles[0]).toMatchObject({name: 'one', apiKey: 'test-secret'});
      expect(config.mcpServers.local).toEqual({transport: 'stdio', command: 'node', args: [], env: {}});
    }
  });

  it('独立项目配置仍使用严格校验', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`);
    expect(() => loadConfig(root, project('profiles: []'), {})).toThrow(/项目级配置无效/);
  });

  it.skipIf(process.platform === 'win32')('工作区通过符号链接指向主目录时不会重复解析配置', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: model
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`);
    const links = mkdtempSync(join(tmpdir(), 'bitori-config-link-'));
    temporaryDirectories.push(links);
    const alias = join(links, 'home');
    symlinkSync(root, alias, 'dir');
    expect(loadConfig(root, alias).profiles[0]?.name).toBe('one');
  });

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
    expect(() => resolveProfileWithApiKey(loadConfig(root))).toThrow(/API key/);
    expect(() => resolveProfile(loadConfig(home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`)), 'missing')).toThrow(/missing/);
  });

  it('缺失 key 的 profile 不阻塞加载，但被选中时显错', () => {
    const root = home(`profiles:
  - name: empty
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${EMPTY}
  - name: valid
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`, 'EMPTY=\nAPI_KEY=test-secret\n');
    const config = loadConfig(root);
    expect(config.profiles).toHaveLength(2);
    expect(resolveProfileWithApiKey(config, 'valid')?.apiKey).toBe('test-secret');
    expect(() => resolveProfileWithApiKey(config, 'empty')).toThrow(/empty 的 API key/);
  });

  it('按用户级到项目级合并 MCP Server，并展开 env/header', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
mcp_servers:
  shared:
    transport: stdio
    command: node
  user-only:
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer \${MCP_TOKEN}
`);
    const workspace = project(`mcp_servers:
  shared:
    transport: stdio
    command: \${NODE_COMMAND}
    args: [server.js]
`);
    const config = loadConfig(root, workspace, {MCP_TOKEN: 'secret-token', NODE_COMMAND: 'node-project'});
    expect(config.mcpServers.shared).toEqual({transport: 'stdio', command: 'node-project', args: ['server.js'], env: {}});
    expect(config.mcpServers['user-only']).toMatchObject({headers: {Authorization: 'Bearer secret-token'}});
    expect(collectSecretValues(config, root)).toContain('Bearer secret-token');
  });

  it('MCP 配置引用缺失变量时显错但不泄漏其他值', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
mcp_servers:
  remote:
    transport: http
    url: https://example.com/mcp
    headers: {Authorization: "Bearer \${MISSING_MCP}"}
`);
    expect(() => loadConfig(root, project('{}'), {})).toThrow(/MISSING_MCP/);
  });

  it('在变量展开后校验 HTTP URL', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
mcp_servers:
  remote:
    transport: http
    url: https://\${MCP_HOST}/mcp
`);
    expect(loadConfig(root, project('{}'), {MCP_HOST: 'localhost'}).mcpServers.remote).toMatchObject({url: 'https://localhost/mcp'});
    expect(() => loadConfig(root, project('{}'), {MCP_HOST: 'bad host'})).toThrow(/HTTP/);
  });
});
