import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {LLMClient, StreamEvent} from '../../../src/providers/types.js';
import {loadAgentDefinitions, parseAgentDefinition} from '../../../src/subagents/loader.js';
import {filterToolsForAgent} from '../../../src/subagents/tool-filter.js';
import {TaskManager} from '../../../src/subagents/task-manager.js';
import {spawnSubAgent} from '../../../src/subagents/spawn.js';
import {BUILTIN_AGENTS} from '../../../src/subagents/types.js';
import type {ToolDefinition} from '../../../src/tools/types.js';

const tools: ToolDefinition[] = [
  {name: 'read_file', description: '', inputSchema: {}},
  {name: 'write_file', description: '', inputSchema: {}},
  {name: 'agent', description: '', inputSchema: {}},
];

describe('SubAgent', () => {
  it('内置 general-purpose/plan/explore 与只读限制', () => {
    expect(new Set(BUILTIN_AGENTS.map(agent => agent.name))).toEqual(new Set(['general-purpose', 'plan', 'explore']));
    const plan = BUILTIN_AGENTS.find(agent => agent.name === 'plan')!;
    expect(plan.disallowedTools).toContain('write_file');
    expect(filterToolsForAgent(tools, plan).map(tool => tool.name)).toEqual(['read_file']);
  });

  it('frontmatter 解析、body 描述回退与坏文件跳过', () => {
    const parsed = parseAgentDefinition('---\nname: test\nmax_turns: 5\nmodel: haiku\n---\n正文');
    expect(parsed).toMatchObject({name: 'test', maxTurns: 5, model: 'haiku', initialPrompt: '正文'});
    expect(parseAgentDefinition('---\nname: x\n---\n正文')?.description).toBe('正文');
    expect(parseAgentDefinition('no frontmatter')).toBeNull();
    expect(parseAgentDefinition('---\ndescription: x\n---\n正文')).toBeNull();
  });

  it('三级加载，项目级覆盖内置', () => {
    const work = mkdtempSync(join(tmpdir(), 'bitori-agents-'));
    const home = mkdtempSync(join(tmpdir(), 'bitori-home-'));
    mkdirSync(join(work, '.bitori', 'agents'), {recursive: true});
    writeFileSync(join(work, '.bitori', 'agents', 'explore.md'), '---\nname: explore\ndescription: 项目探索\n---\n', 'utf8');
    const agents = loadAgentDefinitions(work, home);
    expect(agents.find(agent => agent.name === 'explore')?.description).toBe('项目探索');
  });

  it('后台白名单与全局禁用', () => {
    const definition = {name: 'x', description: ''};
    expect(filterToolsForAgent(tools, definition, {background: true}).map(tool => tool.name)).toEqual(['read_file']);
    expect(filterToolsForAgent(tools, definition)).toHaveLength(2);
  });

  it('子 Agent 输出收集与任务通知', async () => {
    const client: LLMClient = {async *streamChat(): AsyncIterable<StreamEvent> { yield {type: 'text_delta', text: '结果'}; yield {type: 'completed', finishReason: 'stop'}; }};
    await expect(spawnSubAgent({client, definition: BUILTIN_AGENTS[0]!, prompt: '找入口'})).resolves.toBe('结果');
    const manager = new TaskManager();
    const task = manager.launch('explore', '找入口', async () => '后台结果');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(task.status).toBe('completed');
    expect(manager.drainNotifications()[0]).toContain('task-notification');
  });
});
