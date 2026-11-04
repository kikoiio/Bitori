import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildDoctorChecks} from '../../../src/cli/commands/doctor.js';

let home = '';
let workspace = '';
const savedHome = process.env['HOME'];
const savedUserProfile = process.env['USERPROFILE'];

function writeUserConfig(configYaml: string, envText: string): void {
  mkdirSync(join(home, '.bitori'), {recursive: true});
  writeFileSync(join(home, '.bitori', 'config.yaml'), configYaml, 'utf8');
  writeFileSync(join(home, '.bitori', '.env'), envText, 'utf8');
}

const okFetch: typeof fetch = async () => new Response(JSON.stringify({data: [{id: 'probe-model', display_name: 'Probe Model', is_enabled: true}]}), {status: 200, headers: {'Content-Type': 'application/json'}});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bitori-doctor-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'bitori-doctor-ws-'));
  process.env['HOME'] = home;
  // os.homedir() 在 Windows 上只认 USERPROFILE，不看 HOME；两个都设，避免读到真实用户目录。
  process.env['USERPROFILE'] = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
  if (savedUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = savedUserProfile;
  rmSync(home, {recursive: true, force: true});
  rmSync(workspace, {recursive: true, force: true});
  delete process.env['PROBE_KEY'];
});

describe('bitori doctor', () => {
  it('健康配置 + 可连通端点：连接与模型检查为 ok，且退出所需 fail 为 0', async () => {
    process.env['PROBE_KEY'] = 'super-secret-token';
    writeUserConfig(`
profiles:
  - name: local
    protocol: openai-chat
    model: probe-model
    base_url: http://127.0.0.1:9
    api_key: \${PROBE_KEY}
`, 'PROBE_KEY=super-secret-token\n');
    const {checks} = await buildDoctorChecks({json: false}, workspace, okFetch);
    expect(checks.find(check => check.name === '配置解析')?.status).toBe('ok');
    expect(checks.find(check => check.name === '凭据 local')?.status).toBe('ok');
    const connection = checks.find(check => check.name === '连接 local');
    expect(connection?.status).toBe('ok');
    expect(connection?.detail).toContain('probe-model');
    expect(checks.some(check => check.name === '模型 local/probe-model')).toBe(true);
    expect(checks.some(check => check.status === 'fail')).toBe(false);
    expect(JSON.stringify(checks)).not.toContain('super-secret-token');
  });

  it('凭据错误 → fail 且给出可操作指引', async () => {
    process.env['PROBE_KEY'] = 'super-secret-token';
    writeUserConfig(`
profiles:
  - name: local
    protocol: openai-chat
    model: probe-model
    base_url: http://127.0.0.1:9
    api_key: \${PROBE_KEY}
`, 'PROBE_KEY=super-secret-token\n');
    const badFetch: typeof fetch = async () => new Response(JSON.stringify({error: {message: 'invalid api key super-secret-token'}}), {status: 401});
    const {checks} = await buildDoctorChecks({json: false}, workspace, badFetch);
    const connection = checks.find(check => check.name === '连接 local');
    expect(connection?.status).toBe('fail');
    expect(connection?.detail).toContain('authentication');
    expect(connection?.detail).toContain('doctor');
    expect(JSON.stringify(checks)).not.toContain('super-secret-token');
  });

  it('缺少 key 的 profile 立即报告 .env 变量名', async () => {
    writeUserConfig(`
profiles:
  - name: local
    protocol: openai-chat
    model: probe-model
    base_url: http://127.0.0.1:9
    api_key: \${MISSING_KEY}
`, '');
    const {checks} = await buildDoctorChecks({json: false}, workspace, okFetch);
    expect(checks.find(check => check.name === '凭据 local')?.detail).toContain('MISSING_KEY');
    expect(checks.find(check => check.name === '连接 local')).toBeUndefined();
  });

  it('配置损坏时 doctor 依然可用并报告解析错误', async () => {
    writeUserConfig('profiles: [}', 'X=1\n');
    const {checks} = await buildDoctorChecks({json: false}, workspace, okFetch);
    expect(checks.find(check => check.name === '配置解析')?.status).toBe('fail');
    expect(checks.some(check => check.name === '连接 local')).toBe(false);
  });

  it('含项目级 Hooks 且未信任的工作区 → 信任检查为 warn', async () => {
    process.env['PROBE_KEY'] = 'sk-a';
    writeUserConfig(`
profiles:
  - name: local
    protocol: openai-chat
    model: probe-model
    base_url: http://127.0.0.1:9
    api_key: \${PROBE_KEY}
`, 'PROBE_KEY=sk-a\n');
    mkdirSync(join(workspace, '.bitori'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'hooks.yaml'), 'hooks: []\n', 'utf8');
    const before = await buildDoctorChecks({json: false}, workspace, okFetch);
    expect(before.checks.find(check => check.name === '工作区信任')?.status).toBe('warn');
    const {trustWorkspace} = await import('../../../src/config/trust.js');
    await trustWorkspace(workspace);
    const after = await buildDoctorChecks({json: false}, workspace, okFetch);
    expect(after.checks.find(check => check.name === '工作区信任')?.status).toBe('ok');
  });

  it('仅有未信任项目记忆时 doctor 报告并说明信任警告', async () => {
    writeUserConfig('profiles: []\n', '');
    mkdirSync(join(workspace, '.bitori', 'memory'), {recursive: true});
    writeFileSync(join(workspace, '.bitori', 'memory', 'pref.md'), '---\nname: preference\ndescription: concise\ntype: project\n---\nUse concise replies.');
    const {checks} = await buildDoctorChecks({json: false}, workspace, okFetch);
    const trust = checks.find(check => check.name === '工作区信任');
    expect(trust?.status).toBe('warn');
    expect(trust?.detail).toContain('记忆');
  });

  it('--profile 过滤只探测指定 profile', async () => {
    process.env['PROBE_KEY'] = 'sk-a';
    writeUserConfig(`
profiles:
  - name: one
    protocol: openai-chat
    model: probe-model
    base_url: http://127.0.0.1:9
    api_key: \${PROBE_KEY}
  - name: two
    protocol: openai-chat
    model: other-model
    base_url: http://127.0.0.1:9
    api_key: \${PROBE_KEY}
`, 'PROBE_KEY=sk-a\n');
    const {checks} = await buildDoctorChecks({profile: 'one', json: false}, workspace, okFetch);
    expect(checks.filter(check => check.name.startsWith('连接 ')).map(check => check.name)).toEqual(['连接 one']);
  });
});
