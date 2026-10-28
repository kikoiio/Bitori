import {describe, expect, it} from 'vitest';
import {ActiveSkills, SkillExecutor} from '../../../src/skills/executor.js';
import {SkillLoader} from '../../../src/skills/loader.js';
import {TeamManager} from '../../../src/teams/team.js';
import {AgentTool} from '../../../src/tools/implementations/agent-tools.js';
import {EditFileTool} from '../../../src/tools/implementations/edit-file.js';
import {FindFilesTool} from '../../../src/tools/implementations/find-files.js';
import {ReadFileTool} from '../../../src/tools/implementations/read-file.js';
import {RunCommandTool} from '../../../src/tools/implementations/run-command.js';
import {SearchTextTool} from '../../../src/tools/implementations/search-text.js';
import {LoadSkillTool} from '../../../src/tools/implementations/skill-tools.js';
import {TeamTools} from '../../../src/tools/implementations/team-tools.js';
import {EnterWorktreeTool, ExitWorktreeTool} from '../../../src/tools/implementations/worktree-tools.js';
import {WriteFileTool} from '../../../src/tools/implementations/write-file.js';
import {ToolRegistry} from '../../../src/tools/registry.js';

describe('工具输入 schema', () => {
  it.each([
    [new ReadFileTool(), 'path', {path: 'a'}],
    [new WriteFileTool(), 'path', {path: 'a', content: ''}],
    [new EditFileTool(), 'oldText', {path: 'a', oldText: 'x', newText: ''}],
    [new FindFilesTool(), 'pattern', {pattern: '*'}],
    [new SearchTextTool(), 'query', {query: 'x'}],
    [new RunCommandTool(), 'command', {command: 'echo x'}],
    [new LoadSkillTool(new SkillLoader('.'), new SkillExecutor(new ActiveSkills())), 'name', {name: 'x'}],
    [new EnterWorktreeTool(), 'slug', {slug: 'x'}],
    [new AgentTool([], () => { throw new Error('无需模型'); }), 'prompt', {agent: 'x', prompt: 'x'}],
  ])('%s 声明非空约束并拒绝额外参数', (tool, field, valid) => {
    expect(tool.inputSchema).toMatchObject({type: 'object', properties: {[field]: {type: 'string', minLength: 1}}, additionalProperties: false});
    expect(tool.parseArguments(valid)).toBeDefined();
    expect(() => tool.parseArguments({...valid, [field]: ''})).toThrow();
    expect(() => tool.parseArguments({...valid, unexpected: true})).toThrow();
  });

  it('保留可选字段、默认值及 trim 后的运行时检查', () => {
    const search = new SearchTextTool();
    expect(search.inputSchema).toMatchObject({required: ['query'], properties: {filePattern: {type: 'string', minLength: 1}}});
    expect(() => search.parseArguments({query: 'x', filePattern: ''})).toThrow();
    const exit = new ExitWorktreeTool(new EnterWorktreeTool());
    expect(exit.inputSchema).toMatchObject({required: ['slug'], properties: {force: {type: 'boolean', default: false}}});
    expect(exit.parseArguments({slug: ' x '})).toEqual({slug: 'x', force: false});
    expect(() => exit.parseArguments({slug: '  '})).toThrow();
    expect(() => exit.parseArguments({slug: 'x', force: 'true'})).toThrow();
  });

  it('联合 schema 保持各分支边界并对不兼容严格模式的工具显式关闭', () => {
    const team = new TeamTools(new TeamManager('.'));
    expect(team.inputSchema).toMatchObject({type: 'object'});
    expect(team.inputSchema.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({additionalProperties: false, required: ['action', 'name']}),
    ]));
    expect(team.parseArguments({action: 'create', name: 'x'})).toEqual({action: 'create', name: 'x', description: ''});
    expect(() => team.parseArguments({action: 'send', team: 'x', from: '../x', to: 'y', text: 'hi'})).toThrow();
    expect(() => team.parseArguments({action: 'receive', team: 'x', member: 'y', text: 'hi'})).toThrow();
    const registry = new ToolRegistry();
    for (const tool of [new ReadFileTool(), new SearchTextTool(), new ExitWorktreeTool(new EnterWorktreeTool()), team, new AgentTool([], () => { throw new Error('无需模型'); })]) registry.register(tool);
    expect(registry.definitions().map(({name, strict}) => [name, strict])).toEqual([
      ['read_file', undefined], ['search_text', false], ['exit_worktree', false], ['team', false], ['agent', false],
    ]);
  });
});
