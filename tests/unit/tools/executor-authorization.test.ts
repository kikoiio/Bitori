import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {ToolExecutor} from '../../../src/tools/executor.js';
import {PermissionEngine} from '../../../src/tools/permission-engine.js';
import {ToolRegistry} from '../../../src/tools/registry.js';
import {fixedToolLimits} from '../../../src/tools/create-tool-system.js';
import type {Tool, ToolCall} from '../../../src/tools/types.js';

describe('工具执行授权', () => {
  it('直接调用必须具备当前调用的批准，且不能伪造工具效果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-executor-auth-'));
    try {
      const execute = vi.fn().mockResolvedValue({status: 'success', output: {ok: true}});
      const tool: Tool = {name: 'custom_write', effect: 'write', description: 'write', inputSchema: {}, parseArguments: () => ({}), execute};
      const registry = new ToolRegistry(); registry.register(tool);
      const permissions = new PermissionEngine({workspaceRoot: root, userRulesPath: join(root, 'user.yaml'), projectRulesPath: join(root, 'project.yaml'), localRulesPath: join(root, 'local.yaml')});
      const executor = new ToolExecutor(registry, {workspaceRoot: root, limits: fixedToolLimits, permissions});
      const call: ToolCall = {internalId: 'call-1', providerCallId: 'provider-1', position: 0, name: tool.name, arguments: {}, effect: 'write'};
      const signal = new AbortController().signal;
      expect((await executor.execute(call, signal)).status).toBe('denied');
      expect((await executor.execute(call, signal, {approvedCallId: 'other'})).status).toBe('denied');
      expect((await executor.execute({...call, effect: 'read'}, signal, {approvedCallId: call.internalId})).status).toBe('denied');
      expect(execute).not.toHaveBeenCalled();
      expect((await executor.execute(call, signal, {approvedCallId: call.internalId})).status).toBe('success');
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
