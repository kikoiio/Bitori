import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {PermissionEngine} from '../../../src/tools/permission-engine.js';
import type {ToolCall} from '../../../src/tools/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function call(name: ToolCall['name'], effect: ToolCall['effect'], argumentsValue: Record<string, unknown>): ToolCall { return {internalId: `${name}-1`, providerCallId: `${name}-provider`, position: 0, name, effect, arguments: argumentsValue}; }
function engine(root: string, text: {user?: string; project?: string; local?: string} = {}, tools?: string[], projectTrusted = true): PermissionEngine {
  const config = join(root, 'config'); mkdirSync(config, {recursive: true});
  const paths = {userRulesPath: join(config, 'user.yaml'), projectRulesPath: join(config, 'project.yaml'), localRulesPath: join(config, 'local.yaml')};
  if (text.user !== undefined) writeFileSync(paths.userRulesPath, text.user, 'utf8');
  if (text.project !== undefined) writeFileSync(paths.projectRulesPath, text.project, 'utf8');
  if (text.local !== undefined) writeFileSync(paths.localRulesPath, text.local, 'utf8');
  return new PermissionEngine({workspaceRoot: root, ...paths, ...(tools ? {tools} : {}), projectTrusted});
}

describe('PermissionEngine', () => {
  it('黑名单和沙箱位于规则之前，放行规则也不能绕过', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const permissions = engine(root, {user: 'rules:\n  - tool: run_command\n    pattern: "rm -rf *"\n    decision: allow\n'});
    permissions.enableSessionBypass('session-a');
    await expect(permissions.evaluate(call('run_command', 'command', {command: 'rm -rf project'}), 'session-a')).resolves.toMatchObject({decision: 'deny', source: 'blacklist'});
    await expect(permissions.evaluate(call('read_file', 'read', {path: '../outside.txt'}))).resolves.toMatchObject({decision: 'deny', source: 'sandbox'});
  });

  it('三层规则按 deny > ask > allow 合并，glob 可匹配工作区路径', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root); writeFileSync(join(root, '.env'), 'secret', 'utf8');
    const permissions = engine(root, {
      user: 'rules:\n  - tool: read_file\n    pattern: "**/*.env"\n    decision: allow\n',
      project: 'rules:\n  - tool: read_file\n    pattern: "**/*.env"\n    decision: ask\n',
      local: 'rules:\n  - tool: read_file\n    pattern: "**/*.env"\n    decision: deny\n',
    });
    await expect(permissions.evaluate(call('read_file', 'read', {path: '.env'}))).resolves.toMatchObject({decision: 'deny', source: 'rule'});
  });

  it('双星 glob 覆盖命令参数和嵌套工作区路径', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    mkdirSync(join(root, 'src', 'nested'), {recursive: true});
    writeFileSync(join(root, 'src', 'nested', 'existing.ts'), 'old', 'utf8');
    const permissions = engine(root, {user: `rules:
  - tool: run_command
    pattern: "**"
    decision: allow
  - tool: edit_file
    pattern: "**"
    decision: allow
  - tool: write_file
    pattern: "**"
    decision: allow
`});

    await expect(permissions.evaluate(call('run_command', 'command', {command: 'cd /testbed && npm test'}))).resolves.toMatchObject({decision: 'allow', source: 'rule'});
    await expect(permissions.evaluate(call('run_command', 'command', {command: 'cd /testbed && npm test\nnpm run lint'}))).resolves.toMatchObject({decision: 'allow', source: 'rule'});
    await expect(permissions.evaluate(call('edit_file', 'write', {path: 'src/nested/existing.ts', old_text: 'old', new_text: 'new'}))).resolves.toMatchObject({decision: 'allow', source: 'rule'});
    await expect(permissions.evaluate(call('write_file', 'write', {path: 'src/nested/new.ts', content: 'new'}))).resolves.toMatchObject({decision: 'allow', source: 'rule'});
  });

  it('未信任工作区的项目权限规则不生效', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const permissions = engine(root, {project: `rules:
  - tool: write_file
    pattern: new.txt
    decision: allow
`}, undefined, false);
    await expect(permissions.evaluate(call('write_file', 'write', {path: 'new.txt', content: 'x'}))).resolves.toMatchObject({decision: 'ask'});
  });

  it('未信任工作区不加载 permissions.local.yaml 的 allow 规则或 bypass 档', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const permissions = engine(root, {local: 'mode: bypass\nrules:\n  - tool: write_file\n    pattern: "**"\n    decision: allow\n'}, undefined, false);
    expect(permissions.tier).toBe('default');
    await expect(permissions.evaluate(call('write_file', 'write', {path: 'new.txt', content: 'x'}))).resolves.toMatchObject({decision: 'ask'});
  });

  it('三档语义和永久规则可持久化', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root); writeFileSync(join(root, 'note.txt'), 'ok', 'utf8');
    const permissions = engine(root);
    const write = call('write_file', 'write', {path: 'new.txt', content: 'x'});
    await expect(permissions.evaluate(write)).resolves.toMatchObject({decision: 'ask'});
    permissions.enableSessionBypass('session-a');
    await expect(permissions.evaluate(write, 'session-a')).resolves.toMatchObject({decision: 'allow'});
    await expect(permissions.evaluate(write, 'session-b')).resolves.toMatchObject({decision: 'ask'});
    expect(existsSync(join(root, 'config', 'local.yaml'))).toBe(false);
    permissions.clearSessionBypass('session-a');
    await expect(permissions.evaluate(write, 'session-a')).resolves.toMatchObject({decision: 'ask'});
    permissions.setTier('strict'); await expect(permissions.evaluate(call('read_file', 'read', {path: 'note.txt'}))).resolves.toMatchObject({decision: 'ask'});
    expect(readFileSync(join(root, 'config', 'local.yaml'), 'utf8')).not.toContain('mode: bypass');
    permissions.addPermanentAllow(write); expect(existsSync(join(root, 'config', 'local.yaml'))).toBe(true);
    const restored = engine(root, {local: 'mode: default\nrules:\n  - tool: write_file\n    pattern: new.txt\n    decision: allow\n'});
    await expect(restored.evaluate(write)).resolves.toMatchObject({decision: 'allow'});
  });

  it('忽略旧配置中持久化的 bypass 档', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const restored = engine(root, {local: `mode: bypass
rules: []
`});
    expect(restored.hadPersistedBypass).toBe(true);
    expect(restored.tier).toBe('default');
    await expect(restored.evaluate(call('write_file', 'write', {path: 'new.txt', content: 'x'}))).resolves.toMatchObject({decision: 'ask'});
  });

  it('非法规则在加载时明确指出文件', () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root); const bad = join(root, 'bad.yaml'); writeFileSync(bad, 'rules:\n  - tool: nope\n    pattern: "*"\n    decision: allow\n', 'utf8');
    expect(() => new PermissionEngine({workspaceRoot: root, userRulesPath: bad, projectRulesPath: join(root, 'missing-project'), localRulesPath: join(root, 'missing-local')})).toThrow(new RegExp(`${bad.replaceAll('\\', '\\\\')}.*工具名无效`));
  });

  // 远端工具沿用权限引擎，生成的精确规则不能把参数中的 * 当作 glob。
  it('MCP 工具默认询问并支持参数精确的会话放行', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const permissions = engine(root);
    const remote = call('mcp__demo__search', 'command', {query: '*'});
    await expect(permissions.evaluate(remote)).resolves.toMatchObject({decision: 'ask'});
    permissions.addSessionAllow(remote, 'session-a');
    await expect(permissions.evaluate(remote, 'session-a')).resolves.toMatchObject({decision: 'allow'});
    await expect(permissions.evaluate(remote, 'session-b')).resolves.toMatchObject({decision: 'ask'});
    await expect(permissions.evaluate(call('mcp__demo__search', 'command', {query: 'other'}), 'session-a')).resolves.toMatchObject({decision: 'ask'});
  });

  it('扩展工具长效批准绑定完整参数并可从文件回读', async () => {
    const root = mkdtempSync('bitori-permission-'); roots.push(root);
    const registered = ['exit_worktree', 'search_text'];
    const permissions = engine(root, {}, registered);
    const first = call('exit_worktree', 'write', {slug: 'first', force: false});
    const changed = call('exit_worktree', 'write', {slug: 'first', force: true});
    permissions.addSessionAllow(first, 'session-a');
    await expect(permissions.evaluate(first, 'session-a')).resolves.toMatchObject({decision: 'allow'});
    await expect(permissions.evaluate(first, 'session-b')).resolves.toMatchObject({decision: 'ask'});
    await expect(permissions.evaluate(changed, 'session-a')).resolves.toMatchObject({decision: 'ask'});
    permissions.addPermanentAllow(first);
    permissions.addPermanentAllow(call('search_text', 'read', {query: 'needle'}));
    const restored = engine(root, {}, registered);
    await expect(restored.evaluate(first)).resolves.toMatchObject({decision: 'allow'});
    await expect(restored.evaluate(changed)).resolves.toMatchObject({decision: 'ask'});
    expect(restored.allRules().every(rule => rule.pattern.length > 0)).toBe(true);
  });
});
