import {ApprovalCoordinator} from './approval-coordinator.js';
import {ToolExecutor} from './executor.js';
import {EditFileTool} from './implementations/edit-file.js';
import {FindFilesTool} from './implementations/find-files.js';
import {ReadFileTool} from './implementations/read-file.js';
import {RunCommandTool} from './implementations/run-command.js';
import {SearchTextTool} from './implementations/search-text.js';
import {WriteFileTool} from './implementations/write-file.js';
import {ToolRegistry} from './registry.js';
import {PermissionEngine} from './permission-engine.js';
import {McpManager} from '../mcp/manager.js';
import type {Tool} from './types.js';
import {createAgentServices, type AgentServices} from '../agent/services.js';
import {LoadSkillTool} from './implementations/skill-tools.js';
import {AgentTool} from './implementations/agent-tools.js';
import {EnterWorktreeTool, ExitWorktreeTool} from './implementations/worktree-tools.js';
import {TeamTools} from './implementations/team-tools.js';
import type {McpServerConfig} from '../config/types.js';
import type {LLMClient} from '../providers/types.js';

export const fixedToolLimits = {
  read: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500},
  write: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500},
  command: {timeoutMs: 60_000, maxResultBytes: 65_536, maxMatches: 500},
} as const;

/** 组合根只需调用一次，三个 Provider 共享同一注册集合。 */
export function createToolSystem(workspaceRoot: string, mcpServers: Record<string, McpServerConfig> = {}, options: {services?: AgentServices; clientFor?: (model: string | null) => LLMClient; memoryClient?: LLMClient} = {}) {
  const services = options.services ?? createAgentServices({workDir: workspaceRoot});
  const enterWorktree = new EnterWorktreeTool();
  const registry = new ToolRegistry();
  const coreTools: Tool[] = [
    new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new RunCommandTool(), new FindFilesTool(), new SearchTextTool(),
    new LoadSkillTool(services.skills, services.skillExecutor),
    new TeamTools(services.teams),
    enterWorktree,
    new ExitWorktreeTool(enterWorktree),
  ];
  if (options.clientFor) coreTools.push(new AgentTool(services.agents, options.clientFor));
  for (const tool of coreTools) registry.register(tool);
  const permissions = new PermissionEngine({workspaceRoot, tools: registry.entries().map(tool => tool.name)});
  const mcp = new McpManager(registry, mcpServers, workspaceRoot);
  return {registry, executor: new ToolExecutor(registry, {workspaceRoot, limits: fixedToolLimits, permissions}), approvals: new ApprovalCoordinator(), permissions, mcp, services, memoryClient: options.memoryClient ?? null, close: async () => { await Promise.all([services.close(), mcp.close()]); }};
}
