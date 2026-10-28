import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {LLMClient, StreamEvent} from '../../../src/providers/types.js';
import {loadAgentDefinitions, parseAgentDefinition} from '../../../src/subagents/loader.js';
import {spawnSubAgent} from '../../../src/subagents/spawn.js';
import {BUILTIN_AGENTS} from '../../../src/subagents/types.js';
import {AgentTool} from '../../../src/tools/implementations/agent-tools.js';

describe('SubAgent', () => {
  it('内置角色明确说明只提供文本咨询', () => {
    expect(new Set(BUILTIN_AGENTS.map(agent => agent.name))).toEqual(new Set(['general-purpose', 'plan', 'explore']));
    expect(BUILTIN_AGENTS.every(agent => /no tools|cannot search/i.test(agent.description))).toBe(true);
  });

  it('咨询传入背景并拒绝未实现的工具配置', async () => {
    let sent = '';
    const client: LLMClient = {async *streamChat(input) { sent = input.messages[0]?.content ?? ''; yield {type: 'text_delta', text: '建议'}; yield {type: 'completed', finishReason: 'stop'}; }};
    const tool = new AgentTool([...BUILTIN_AGENTS, {name: 'unsupported', description: '', unsupportedFields: ['tools']}], () => client);
    const context = {workspaceRoot: '.', signal: new AbortController().signal, limits: {timeoutMs: 1000, maxResultBytes: 1000, maxMatches: 10}};
    await expect(tool.execute(tool.parseArguments({agent: 'plan', prompt: '分析', context: '背景'}), context)).resolves.toMatchObject({status: 'success', output: {toolCount: 0}});
    expect(sent).toContain('背景');
    expect(sent).toContain('no tools');
    await expect(tool.execute(tool.parseArguments({agent: 'unsupported', prompt: 'x'}), context)).resolves.toMatchObject({status: 'error'});
  });

  it('frontmatter 解析、body 描述回退与坏文件跳过', () => {
    const parsed = parseAgentDefinition('---\nname: test\nmax_turns: 5\nmodel: haiku\n---\n正文');
    expect(parsed).toMatchObject({name: 'test', unsupportedFields: ['max_turns'], model: 'haiku', initialPrompt: '正文'});
    expect(parseAgentDefinition('---\nname: x\n---\n正文')?.description).toBe('正文');
    expect(parseAgentDefinition('no frontmatter')).toBeNull();
    expect(parseAgentDefinition('---\ndescription: x\n---\n正文')).toBeNull();
  });

  it('三级加载，项目级覆盖内置', ({onTestFinished}) => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-agents-'));
    onTestFinished(() => rmSync(work, {recursive: true, force: true}));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    onTestFinished(() => rmSync(home, {recursive: true, force: true}));
    mkdirSync(join(work, '.bitori', 'agents'), {recursive: true});
    writeFileSync(join(work, '.bitori', 'agents', 'explore.md'), '---\nname: explore\ndescription: 项目探索\n---\n', 'utf8');
    const agents = loadAgentDefinitions(work, home);
    expect(agents.find(agent => agent.name === 'explore')?.description).toBe('项目探索');
  });

  it('子 Agent 输出收集', async () => {
    const client: LLMClient = {async *streamChat(): AsyncIterable<StreamEvent> { yield {type: 'text_delta', text: '结果'}; yield {type: 'completed', finishReason: 'stop'}; }};
    await expect(spawnSubAgent({client, definition: BUILTIN_AGENTS[0]!, prompt: '找入口'})).resolves.toBe('结果');
    await expect(spawnSubAgent({client, definition: {name: 'bad', description: '', unsupportedFields: ['background']}, prompt: 'x'})).rejects.toThrow('不支持配置');
  });
});
