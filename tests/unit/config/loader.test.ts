import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parse as parseYaml} from 'yaml';
import {defaultUserConfigYaml, defaultUserEnv} from '../../../src/config/defaults.js';
import {collectSecretValues, loadConfig, resolveProfile, resolveProfileWithApiKey} from '../../../src/config/loader.js';
import {parseConfig} from '../../../src/config/schema.js';

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

function trust(homeRoot: string, workspace: string): void {
  // Trust manifests are deliberately rejected when group/other readable; keep
  // the fixture portable across runners with different default umasks.
  writeFileSync(join(homeRoot, '.bitori', 'trusted-workspaces.json'), JSON.stringify([workspace]), {mode: 0o600});
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
    const workspace = project('profiles: []');
    trust(root, workspace);
    expect(() => loadConfig(root, workspace, {})).toThrow(/项目级配置无效/);
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

  it('从 .env 展开模型、URL 和密钥，并允许进程环境覆盖', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}
`, 'LLM_API_KEY=file-secret\nLLM_BASE_URL=https://file.example.com/v1\nLLM_MODEL=file-model\n');
    expect(loadConfig(root, root, {}).profiles[0]).toMatchObject({
      model: 'file-model', baseUrl: 'https://file.example.com/v1', apiKey: 'file-secret',
    });
    expect(loadConfig(root, root, {
      LLM_API_KEY: 'runtime-secret', LLM_BASE_URL: 'https://runtime.example.com/v1', LLM_MODEL: 'runtime-model',
    }).profiles[0]).toMatchObject({
      model: 'runtime-model', baseUrl: 'https://runtime.example.com/v1', apiKey: 'runtime-secret',
    });
  });

  it('未填写的 profile 变量延迟到选中时再报错，不阻塞启动', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}
`, 'LLM_API_KEY=test-secret\n');
    const config = loadConfig(root, root, {});
    expect(config.profiles[0]).toMatchObject({model: '', baseUrl: '', missingVariables: ['LLM_MODEL', 'LLM_BASE_URL']});
    expect(() => resolveProfileWithApiKey(config, 'one')).toThrow(/请在 .env 中填写 LLM_MODEL、LLM_BASE_URL/);
    expect(() => loadConfig(root, root, {LLM_MODEL: 'model', LLM_BASE_URL: 'file:///x', LLM_API_KEY: 'test-secret'})).toThrow(/base_url.*HTTP/);
    expect(() => loadConfig(root, root, {LLM_MODEL: 'model', LLM_BASE_URL: 'bad host', LLM_API_KEY: 'test-secret'})).toThrow(/base_url.*HTTP/);
    expect(loadConfig(root, root, {LLM_MODEL: ' ', LLM_BASE_URL: 'https://example.com', LLM_API_KEY: 'test-secret'}).profiles[0]).toMatchObject({missingVariables: ['LLM_MODEL']});
  });

  it('缺失用户配置时写入通用模板并给出 .env 填法指引', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-config-scaffold-'));
    temporaryDirectories.push(root);
    expect(() => loadConfig(root, root, {})).toThrow(/填一组变量|_API_KEY/);
    expect(readFileSync(join(root, '.bitori', 'config.yaml'), 'utf8')).toBe(defaultUserConfigYaml);
    expect(readFileSync(join(root, '.bitori', '.env'), 'utf8')).toBe(defaultUserEnv);
    const config = loadConfig(root, root, {});
    expect(config.profiles.map(profile => profile.name)).toEqual(['default']);
    expect(() => resolveProfileWithApiKey(config)).toThrow(/LLM_MODEL/);
  });

  it('.env 变量组自动派生 profile，多 Provider 只改 .env', () => {
    const root = home('profiles: []\n');
    const config = loadConfig(root, root, {OPENROUTER_API_KEY: 'sk-or', OPENROUTER_MODEL: 'deepseek/deepseek-chat'});
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0]).toMatchObject({name: 'openrouter', protocol: 'openai-chat', model: 'deepseek/deepseek-chat', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-or', apiKeyVariable: 'OPENROUTER_API_KEY'});
    const multi = loadConfig(root, root, {
      OPENROUTER_API_KEY: 'sk-or', OPENROUTER_MODEL: 'm1',
      ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_MODEL: 'claude-x', ANTHROPIC_PROTOCOL: 'anthropic',
      QODER_API_KEY: 'pt-x', QODER_MODEL: 'DeepSeek-Flash', QODER_BASE_URL: 'https://api.qoder.com.cn', QODER_PROTOCOL: 'qoder',
    });
    expect(multi.profiles.map(profile => profile.name)).toEqual(['anthropic', 'openrouter', 'qoder']);
    expect(multi.profiles.find(profile => profile.name === 'qoder')).toMatchObject({protocol: 'qoder', baseUrl: 'https://api.qoder.com.cn'});
    expect(multi.profiles.find(profile => profile.name === 'anthropic')).toMatchObject({baseUrl: 'https://api.anthropic.com'});
  });

  it('显式 profile 引用的变量组不重复派生；残组只提示不阻塞', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: \${OR_MODEL}
    base_url: https://explicit.example.com/v1
    api_key: \${OR_API_KEY}
`);
    const config = loadConfig(root, root, {OR_API_KEY: 'k', OR_MODEL: 'explicit-model', OPENROUTER_MODEL: 'm', OPENROUTER_BASE_URL: 'https://x.example.com', GITHUB_API_KEY: 'lone'});
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0]).toMatchObject({model: 'explicit-model', apiKey: 'k'});
    // GITHUB_API_KEY 单员沉默；OPENROUTER 缺 key 有提示。
    expect(config.notices?.some(notice => notice.includes('OPENROUTER_API_KEY'))).toBe(true);
    expect(config.notices?.every(notice => !notice.includes('GITHUB'))).toBe(true);
  });

  it('qoder 派生缺 BASE_URL、非法协议、零 profile 各给明确指引', () => {
    const root = home('profiles: []\n');
    const mixed = loadConfig(root, root, {ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'b', QODER_API_KEY: 'p', QODER_MODEL: 'm', QODER_PROTOCOL: 'qoder', BAD_API_KEY: 'x', BAD_MODEL: 'y', BAD_PROTOCOL: 'mistral'});
    expect(mixed.profiles.map(profile => profile.name)).toEqual(['anthropic']);
    expect(mixed.notices?.some(notice => notice.includes('QODER_BASE_URL'))).toBe(true);
    expect(mixed.notices?.some(notice => notice.includes('mistral'))).toBe(true);
    expect(() => loadConfig(root, root, {STRAY_API_KEY: 'x'})).toThrow(/没有可用 profile/);
  });

  it('首次运行时环境已带连接参数就直接可用，不要求先填 .env', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-first-run-'));
    temporaryDirectories.push(root);
    // CI 与已导出变量的终端本来就带着凭据，不该再被"请去填 .env"挡住。
    const config = loadConfig(root, root, {LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.scnet.cn/api/llm/anthropic'});
    expect(config.profiles[0]).toMatchObject({name: 'default', protocol: 'anthropic'});
    expect(config.profiles[0]?.apiKey).toBe('k');
  });

  it('首次运行且没有可用连接参数时，仍然提示去填 .env', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-first-run-empty-'));
    temporaryDirectories.push(root);
    expect(() => loadConfig(root, root, {})).toThrow(/已创建/);
  });

  it('默认 config.yaml 模板本身合法；.env 仓库示例与首次启动模板一致', () => {
    // config.yaml 的模板只在 src/config/defaults.ts 维护，仓库不再保留副本，这里守住模板的可解析性与结构。
    const parsed = parseConfig(parseYaml(defaultUserConfigYaml));
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({name: 'default', model: '${LLM_MODEL}', base_url: '${LLM_BASE_URL}', api_key: '${LLM_API_KEY}'});
    // 模板不再写死协议：方言由 loader 按地址与密钥形状推断。
    expect(parsed.profiles[0]?.protocol).toBeUndefined();
    // 比较内容而不是字节：Windows 检出若被转成 CRLF，实体文件与源码里的 \n 转义就不一致。
    expect(readFileSync('.env.example', 'utf8').replace(/\r\n/g, '\n')).toBe(defaultUserEnv);
  });

  it('协议优先级：config.yaml 显式 > .env 的 <前缀>_PROTOCOL > 按地址与密钥形状推断', () => {
    const yaml = `profiles:
  - name: local
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}
`;
    const anthropicEnv = {LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://api.scnet.cn/api/llm/anthropic'};
    const inferred = loadConfig(home(yaml, 'LLM_API_KEY=k\nLLM_MODEL=m\nLLM_BASE_URL=https://api.scnet.cn/api/llm/anthropic\n'), '', anthropicEnv);
    expect(inferred.profiles[0]).toMatchObject({protocol: 'anthropic', protocolSource: 'inferred'});
    expect(inferred.profiles[0]?.protocolReason).toContain('anthropic');

    // 地址看不出方言时按 OpenAI 兼容兜底，并说明可以写死。
    const openAiEnv = {LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://host.invalid/v1'};
    const fallback = loadConfig(home(yaml, 'LLM_API_KEY=k\nLLM_MODEL=m\nLLM_BASE_URL=https://host.invalid/v1\n'), '', openAiEnv);
    expect(fallback.profiles[0]).toMatchObject({protocol: 'openai-chat', protocolSource: 'inferred'});
    expect(fallback.profiles[0]?.protocolReason).toContain('config.yaml');

    const pinned = loadConfig(home(`profiles:
  - name: local
    protocol: openai-responses
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}
`, 'LLM_API_KEY=k\nLLM_MODEL=m\nLLM_BASE_URL=https://host.invalid/v1\n'), '', openAiEnv);
    expect(pinned.profiles[0]).toMatchObject({protocol: 'openai-responses', protocolSource: 'config'});
  });

  it('.env 的 <前缀>_PROTOCOL 覆盖推断结果', () => {
    const yaml = `profiles:
  - name: local
    model: \${LLM_MODEL}
    base_url: \${LLM_BASE_URL}
    api_key: \${LLM_API_KEY}
`;
    const root = home(yaml, 'LLM_API_KEY=k\nLLM_MODEL=m\nLLM_BASE_URL=https://host.invalid/v1\nLLM_PROTOCOL=anthropic\n');
    const config = loadConfig(root, '', {LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'https://host.invalid/v1', LLM_PROTOCOL: 'anthropic'});
    expect(config.profiles[0]).toMatchObject({protocol: 'anthropic', protocolSource: 'env'});
    expect(config.profiles[0]?.protocolReason).toContain('LLM_PROTOCOL');
  });

  it('变量组派生的 profile 同样按地址形状推断方言', () => {
    const root = home('profiles: []\n', 'SCNET_API_KEY=k\nSCNET_MODEL=m\nSCNET_BASE_URL=https://api.scnet.cn/api/llm/anthropic\n');
    const config = loadConfig(root, '', {SCNET_API_KEY: 'k', SCNET_MODEL: 'm', SCNET_BASE_URL: 'https://api.scnet.cn/api/llm/anthropic'});
    expect(config.profiles[0]).toMatchObject({name: 'scnet', protocol: 'anthropic', protocolSource: 'inferred'});
  });

  it('缺失文件、变量和未知 profile 给出安全错误', () => {
    const root = home(`profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${MISSING}
`);
    expect(() => resolveProfileWithApiKey(loadConfig(root))).toThrow(/MISSING/);
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
    expect(() => resolveProfileWithApiKey(config, 'empty')).toThrow(/EMPTY/);
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
    trust(root, workspace);
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
