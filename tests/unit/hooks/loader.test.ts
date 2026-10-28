import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadHookConfigs} from '../../../src/hooks/loader.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

function setup(home: string, work: string): void {
  mkdirSync(join(home, '.bitori'), {recursive: true});
  mkdirSync(join(work, '.bitori'), {recursive: true});
}

describe('Hook 配置加载', () => {
  it('加载失败策略并拒绝未实现的 agent 动作', () => {
    const home = mkdtempSync(join(tmpdir(), 'bitori-hooks-home-'));
    const work = mkdtempSync(join(tmpdir(), 'bitori-hooks-work-'));
    roots.push(home, work); setup(home, work);
    const path = join(work, '.bitori', 'hooks.yaml');
    writeFileSync(path, '- event: pre_tool_use\n  reject: true\n  failure_policy: open\n  timeout_ms: 50\n  action: {type: http, url: "https://example.invalid"}\n', 'utf8');
    expect(loadHookConfigs(work, home)[0]).toMatchObject({failurePolicy: 'open', timeoutMs: 50});
    writeFileSync(path, '- event: startup\n  action: {type: agent, prompt: test}\n', 'utf8');
    expect(() => loadHookConfigs(work, home)).toThrow(/Hook 配置无效/);
  });
  it('用户级先加载，项目级追加', () => {
    const home = mkdtempSync(join(tmpdir(), 'bitori-hooks-home-'));
    const work = mkdtempSync(join(tmpdir(), 'bitori-hooks-work-'));
    roots.push(home, work); setup(home, work);
    writeFileSync(join(home, '.bitori', 'hooks.yaml'), '- event: startup\n  action: {type: prompt, prompt: user}\n', 'utf8');
    writeFileSync(join(work, '.bitori', 'hooks.yaml'), '- event: turn_start\n  action: {type: prompt, prompt: project}\n', 'utf8');
    const hooks = loadHookConfigs(work, home);
    expect(hooks.map(hook => hook.event)).toEqual(['startup', 'turn_start']);
  });

  it('非法配置在启动时显错且包含路径', () => {
    const home = mkdtempSync(join(tmpdir(), 'bitori-hooks-home-'));
    const work = mkdtempSync(join(tmpdir(), 'bitori-hooks-work-'));
    roots.push(home, work); setup(home, work);
    writeFileSync(join(work, '.bitori', 'hooks.yaml'), '- event: startup\n  action: {type: command}\n', 'utf8');
    expect(() => loadHookConfigs(work, home)).toThrow(/项目级 Hook 配置无效/);
  });
});
