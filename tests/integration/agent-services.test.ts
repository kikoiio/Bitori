import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createAgentServices} from '../../src/agent/services.js';
import {createToolSystem} from '../../src/tools/create-tool-system.js';
import {ChatController} from '../../src/chat/agent-controller.js';
import {SessionRepository} from '../../src/storage/repository.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest, LLMClient, StreamEvent} from '../../src/providers/types.js';

class EchoClient implements LLMClient {
  readonly requests: ChatRequest[] = [];
  async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield {type: 'text_delta', text: 'ok'};
    yield {type: 'completed', finishReason: 'stop'};
  }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
const profile: ProviderProfile = {name: 'test', protocol: 'openai-chat', model: 'm', baseUrl: 'https://example.com', apiKey: 'test', thinking: {type: 'disabled'}};

describe('Agent services integration', () => {
  it('模型能看到 load_skill、worktree、team 和 SubAgent 工具', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-services-')); roots.push(root);
    const services = createAgentServices({workDir: root});
    const tools = createToolSystem(root, {}, {services, clientFor: () => new EchoClient()});
    const names = tools.registry.definitions().map(tool => tool.name);
    expect(names).toContain('load_skill');
    expect(names).toContain('enter_worktree');
    expect(names).toContain('exit_worktree');
    expect(names).toContain('team');
    expect(names).toContain('agent');
    tools.close();
  });

  it('Skill 目录进入系统提示并可由 load_skill 激活', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-skill-')); roots.push(root);
    mkdirSync(join(root, '.bitori', 'skills'), {recursive: true});
    writeFileSync(join(root, '.bitori', 'skills', 'demo.md'), '---\nname: demo\ndescription: 演示技能\nallowed-tools: ""\nmode: inline\n---\n\nDo the demo.', 'utf8');
    const services = createAgentServices({workDir: root});
    const tools = createToolSystem(root, {}, {services});
    const client = new EchoClient();
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, tools);
    await controller.initialize(profile);
    await controller.sendMessage('hello');
    const system = client.requests[0]?.system ?? [];
    expect(system.map(block => block.text).join('\n')).toContain('demo: 演示技能');
    const skill = tools.registry.get('load_skill')!;
    const result = await skill.execute({name: 'demo'}, {workspaceRoot: root, signal: new AbortController().signal, limits: {timeoutMs: 1000, maxResultBytes: 1024, maxMatches: 10}});
    expect(result).toMatchObject({status: 'success', output: {name: 'demo'}});
    expect(services.activeSkills.render()).toContain('Do the demo.');
    await controller.shutdown();
  });

  it('记忆进入系统提示，回合结束后触发提取', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-memory-')); roots.push(root);
    const services = createAgentServices({workDir: root});
    services.memory.write('project', 'pref.md', {name: '偏好', description: '用户偏好简洁回复', type: 'project'}, '喜欢简洁回复');
    const tools = createToolSystem(root, {}, {services});
    const client = new EchoClient();
    const repository = new SessionRepository(join(root, 'db.sqlite'));
    const controller = new ChatController(client, repository, tools);
    await controller.initialize(profile);
    await controller.sendMessage('hello');
    expect(client.requests[0]?.system?.map(block => block.text).join('\n')).toContain('用户偏好简洁回复');
    await controller.shutdown();
  });

  it('模型可通过 agent 工具派出子 Agent 并拿回结果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-subagent-')); roots.push(root);
    const services = createAgentServices({workDir: root});
    class SubAgentClient implements LLMClient {
      async *streamChat(): AsyncIterable<StreamEvent> { yield {type: 'text_delta', text: '子代理完成研究'}; yield {type: 'completed', finishReason: 'stop'}; }
    }
    const tools = createToolSystem(root, {}, {services, clientFor: () => new SubAgentClient()});
    const agentTool = tools.registry.get('agent')!;
    const result = await agentTool.execute({agent: 'explore', prompt: '查找入口文件'}, {workspaceRoot: root, signal: new AbortController().signal, limits: {timeoutMs: 5000, maxResultBytes: 10240, maxMatches: 10}});
    expect(result).toMatchObject({status: 'success', output: {agent: 'explore', output: '子代理完成研究'}});
    tools.close();
  });
});
