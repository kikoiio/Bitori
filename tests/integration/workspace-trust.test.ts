import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createAgentServices} from '../../src/agent/services.js';
import {loadConfig} from '../../src/config/loader.js';
import {trustWorkspace} from '../../src/config/trust.js';
import {loadHookConfigs} from '../../src/hooks/loader.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'bitori-trust-home-'));
  roots.push(root);
  mkdirSync(join(root, '.bitori'), {recursive: true});
  writeFileSync(join(root, '.bitori', 'config.yaml'), `profiles:
  - name: one
    protocol: openai-chat
    model: gpt
    base_url: https://example.com/v1
    api_key: \${API_KEY}
`, 'utf8');
  writeFileSync(join(root, '.bitori', '.env'), 'API_KEY=test-secret\n', 'utf8');
  return root;
}

function makeWorkspace(projectConfig: string | null, hooksYaml: string | null): string {
  const workspace = mkdtempSync(join(tmpdir(), 'bitori-trust-ws-'));
  roots.push(workspace);
  if (projectConfig !== null || hooksYaml !== null) mkdirSync(join(workspace, '.bitori'), {recursive: true});
  if (projectConfig !== null) writeFileSync(join(workspace, '.bitori', 'config.yaml'), projectConfig, 'utf8');
  if (hooksYaml !== null) writeFileSync(join(workspace, '.bitori', 'hooks.yaml'), hooksYaml, 'utf8');
  return workspace;
}

const rejectingHooks = `- event: pre_tool_use
  action:
    type: command
    command: node
    args: [-e, "process.exit(1)"]
  reject: true
`;

describe('工作区信任强制化', () => {
  it('未信任工作区：loadConfig 跳过项目级 MCP 并给出 notices', async () => {
    const home = makeHome();
    const workspace = makeWorkspace('mcp_servers:\n  sneaky:\n    transport: stdio\n    command: node\n', null);
    const untrusted = loadConfig(home, workspace, {});
    expect(untrusted.mcpServers.sneaky).toBeUndefined();
    expect(untrusted.notices?.some(notice => notice.includes('未信任'))).toBe(true);

    await trustWorkspace(workspace, home);
    const trusted = loadConfig(home, workspace, {});
    expect(trusted.mcpServers.sneaky).toBeDefined();
    expect(trusted.notices === undefined || trusted.notices.length === 0).toBe(true);
  });

  it('未信任工作区：项目级 Hook 不加载，因此无法拦截工具', async () => {
    const home = makeHome();
    const workspace = makeWorkspace(null, rejectingHooks);
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const untrusted = createAgentServices({workDir: workspace});
      const ignored = await untrusted.hooks.fire('pre_tool_use', {event: 'pre_tool_use', toolName: 'write_file', args: {path: 'x'}});
      expect(ignored.every(result => !result.reject)).toBe(true);
      await untrusted.close();
    } finally {
      if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    }
  });

  it('projectTrusted=true 时同样的项目 Hook 生效并拒绝', async () => {
    const home = makeHome();
    const workspace = makeWorkspace(null, rejectingHooks);
    const savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      const trusted = createAgentServices({workDir: workspace, projectTrusted: true});
      const results = await trusted.hooks.fire('pre_tool_use', {event: 'pre_tool_use', toolName: 'write_file', args: {path: 'x'}});
      expect(results.some(result => result.reject)).toBe(true);
      await trusted.close();
    } finally {
      if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    }
  });

  it('loadHookConfigs includeProject=false 只保留用户级', () => {
    const home = makeHome();
    const workspace = makeWorkspace(null, rejectingHooks);
    writeFileSync(join(home, '.bitori', 'hooks.yaml'), rejectingHooks, 'utf8');
    expect(loadHookConfigs(workspace, home, false)).toHaveLength(1);
    expect(loadHookConfigs(workspace, home, true)).toHaveLength(2);
  });
});
