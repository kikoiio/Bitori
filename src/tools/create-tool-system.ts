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
import type {McpServerConfig} from '../config/types.js';

export const fixedToolLimits = {
  read: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500},
  write: {timeoutMs: 10_000, maxResultBytes: 65_536, maxMatches: 500},
  command: {timeoutMs: 60_000, maxResultBytes: 65_536, maxMatches: 500},
} as const;

/** [s02] 组合根只需调用一次，三个 Provider 共享同一注册集合。 */
/* [s02 旧实现，s06 替换] createToolSystem(workspaceRoot) 只注册六个内置工具。 */
export function createToolSystem(workspaceRoot: string, mcpServers: Record<string, McpServerConfig> = {}) {
  const permissions = new PermissionEngine({workspaceRoot});
  const registry = new ToolRegistry();
  for (const tool of [new ReadFileTool(), new WriteFileTool(), new EditFileTool(), new RunCommandTool(), new FindFilesTool(), new SearchTextTool()]) registry.register(tool);
  const mcp = new McpManager(registry, mcpServers, workspaceRoot);
  return {registry, executor: new ToolExecutor(registry, {workspaceRoot, limits: fixedToolLimits, permissions}), approvals: new ApprovalCoordinator(), permissions, mcp, close: () => mcp.close()};
}
