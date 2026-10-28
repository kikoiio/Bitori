import {now} from '../shared/ids.js';
import type {ApprovalCoordinator} from '../tools/approval-coordinator.js';
import type {ToolExecutor} from '../tools/executor.js';
import type {PreparedToolCall, ToolCall, ToolExecutionResult} from '../tools/types.js';
import type {ApprovalDecision} from '../tools/types.js';
import type {PermissionCheck, PermissionEngine} from '../tools/permission-engine.js';
import type {HookEngine} from '../hooks/engine.js';
import type {AgentEvent} from './types.js';

export type ToolExecutionSegment = {kind: 'parallel_reads'; calls: ToolCall[]} | {kind: 'side_effect'; call: ToolCall};
export interface ToolBatchResult {orderedResults: Array<{call: PreparedToolCall; result: ToolExecutionResult}>}
export interface SchedulerInput {runId: string; sessionId: string; iterationId: string; calls: PreparedToolCall[]; signal: AbortSignal; iteration: number; maxIterations: number}

function interrupted(): ToolExecutionResult { return {status: 'interrupted', error: {code: 'interrupted', message: '工具执行已取消', retryable: false}}; }
function status(result: ToolExecutionResult) { return result.status === 'success' ? 'succeeded' as const : result.status === 'timeout' ? 'timed_out' as const : result.status === 'interrupted' ? 'interrupted' as const : result.status === 'denied' ? 'skipped' as const : 'failed' as const; }

/** 连续读取并发；每个副作用形成审批与执行屏障。 */
export class SafetyBatchScheduler {
  readonly permissions: PermissionEngine | undefined;
  readonly #hooks: HookEngine | null;
  constructor(readonly executor: ToolExecutor, readonly approvals: ApprovalCoordinator, permissions?: PermissionEngine, hooks?: HookEngine | null) {
    this.permissions = permissions ?? executor.options.permissions;
    this.#hooks = hooks ?? null;
  }

  segments(calls: PreparedToolCall[], checks = new Map<string, PermissionCheck>()): ToolExecutionSegment[] {
    const segments: ToolExecutionSegment[] = [];
    for (const prepared of [...calls].sort((a, b) => (a.availability === 'available' ? a.call.position : a.draft.position) - (b.availability === 'available' ? b.call.position : b.draft.position))) {
      if (prepared.availability !== 'available') continue;
      if (prepared.call.effect === 'read' && checks.get(prepared.call.internalId)?.decision !== 'ask') {
        const last = segments.at(-1);
        if (last?.kind === 'parallel_reads') last.calls.push(prepared.call); else segments.push({kind: 'parallel_reads', calls: [prepared.call]});
      } else segments.push({kind: 'side_effect', call: prepared.call});
    }
    return segments;
  }

  async *execute(input: SchedulerInput): AsyncGenerator<AgentEvent, ToolBatchResult, void> {
    const results = new Map<string, ToolExecutionResult>(); let completed = 0;
    const base = () => ({runId: input.runId, sessionId: input.sessionId, at: now(), iterationId: input.iterationId});
    for (const prepared of input.calls) if (prepared.availability !== 'available') {
      results.set(prepared.draft.internalId, prepared.result); completed++;
      yield {...base(), type: 'tool_status', callId: prepared.draft.internalId, status: 'failed'};
      yield {...base(), type: 'tool_result', callId: prepared.draft.internalId, result: prepared.result};
    }
    const checks = new Map<string, PermissionCheck>(); const executable: PreparedToolCall[] = [];
    for (const prepared of input.calls) if (prepared.availability === 'available') {
      if (!this.permissions) { executable.push(prepared); continue; }
      const check = await this.permissions.evaluate(prepared.call); checks.set(prepared.call.internalId, check);
      if (check.decision === 'deny') {
        const prompt = this.#prompt(prepared.call, check.reason);
        yield {...base(), type: 'approval_resolved', callId: prepared.call.internalId, prompt, decision: 'denied'};
        const result = this.permissions.denialResult(check); results.set(prepared.call.internalId, result); completed++;
        yield {...base(), type: 'tool_status', callId: prepared.call.internalId, status: 'skipped'};
        yield {...base(), type: 'tool_result', callId: prepared.call.internalId, result};
      } else executable.push(prepared);
    }
    for (const segment of this.segments(executable, checks)) {
      if (input.signal.aborted) break;
      if (segment.kind === 'parallel_reads') {
        for (const call of segment.calls) yield {...base(), type: 'tool_status', callId: call.internalId, status: 'running'};
        const settled = await Promise.all(segment.calls.map(async call => [call, await this.#executeWithReadGuard(call, input.signal)] as const));
        for (const [call, result] of settled) {
          results.set(call.internalId, result); completed++;
          yield {...base(), type: 'tool_status', callId: call.internalId, status: status(result)};
          yield {...base(), type: 'tool_result', callId: call.internalId, result};
          await this.#afterTool(call, result);
        }
      } else {
        const call = segment.call;
        const check = checks.get(call.internalId); const needsApproval = check?.decision === 'ask' || (!this.permissions && call.effect !== 'read');
        const prompt = this.#prompt(call, check?.reason);
        let decision: ApprovalDecision;
        let hookRejected: string | null = null;
        if (this.#hooks) {
          const guard = await this.#hooks.firePreToolHooks(call.name, call.arguments);
          if (guard.rejected) hookRejected = guard.reason;
        }
        let result: ToolExecutionResult;
        if (hookRejected !== null) {
          result = {status: 'denied', error: {code: 'hook_rejected', message: hookRejected, retryable: false}};
        } else if (needsApproval) {
          await this.#hooks?.fire('permission_request', {event: 'permission_request', toolName: call.name, args: call.arguments});
          yield {...base(), type: 'approval_requested', callId: call.internalId, prompt};
          decision = await this.approvals.request(call, true, check?.reason);
          yield {...base(), type: 'approval_resolved', callId: call.internalId, prompt, decision};
          if (decision === 'approved_session' && this.permissions) this.permissions.addSessionAllow(call);
          if (decision === 'approved_permanent' && this.permissions) this.permissions.addPermanentAllow(call);
          result = input.signal.aborted
            ? interrupted()
            : decision === 'denied'
              ? {status: 'denied', error: {code: 'denied', message: '用户拒绝了工具调用', retryable: false, details: {source: 'human', reason: '用户在人在回路中拒绝了调用'}}}
              : await this.#executeChecked(call, input.signal);
        } else {
          if (call.effect !== 'read') yield {...base(), type: 'approval_resolved', callId: call.internalId, prompt, decision: 'approved'};
          result = input.signal.aborted ? interrupted() : await this.#executeChecked(call, input.signal);
        }
        results.set(call.internalId, result); completed++; yield {...base(), type: 'tool_status', callId: call.internalId, status: status(result)}; yield {...base(), type: 'tool_result', callId: call.internalId, result};
        await this.#afterTool(call, result);
      }
      yield {runId: input.runId, sessionId: input.sessionId, at: now(), type: 'progress', iteration: input.iteration, maxIterations: input.maxIterations, phase: 'executing_tools', completedTools: completed, totalTools: input.calls.length};
    }
    if (input.signal.aborted) for (const prepared of input.calls) {
      const id = prepared.availability === 'available' ? prepared.call.internalId : prepared.draft.internalId;
      if (!results.has(id)) { const result = interrupted(); results.set(id, result); yield {...base(), type: 'tool_status', callId: id, status: 'interrupted'}; yield {...base(), type: 'tool_result', callId: id, result}; }
    }
    return {orderedResults: [...input.calls].sort((a, b) => (a.availability === 'available' ? a.call.position : a.draft.position) - (b.availability === 'available' ? b.call.position : b.draft.position)).map(call => ({call, result: results.get(call.availability === 'available' ? call.call.internalId : call.draft.internalId) ?? interrupted()}))};
  }

  #prompt(call: ToolCall, reason?: string) { return {callId: call.internalId, toolName: call.name, effect: call.effect, argumentSummary: JSON.stringify(call.arguments), riskMessage: call.effect === 'command' ? '批准的命令可能访问网络、启动子进程或影响工作区外资源。' : null, ...(reason === undefined ? {} : {reason})}; }

  async #executeWithReadGuard(call: ToolCall, signal: AbortSignal): Promise<ToolExecutionResult> {
    if (this.#hooks) {
      const guard = await this.#hooks.firePreToolHooks(call.name, call.arguments);
      if (guard.rejected) return {status: 'denied', error: {code: 'hook_rejected', message: guard.reason, retryable: false}};
    }
    return this.#executeChecked(call, signal);
  }

  async #executeChecked(call: ToolCall, signal: AbortSignal): Promise<ToolExecutionResult> {
    if (call.effect === 'command') await this.#hooks?.fire('command_execute', {event: 'command_execute', toolName: call.name, args: call.arguments});
    return this.executor.execute(call, signal);
  }

  async #afterTool(call: ToolCall, result: ToolExecutionResult): Promise<void> {
    const path = typeof call.arguments.path === 'string' ? call.arguments.path : undefined;
    await this.#hooks?.fire('post_tool_use', {event: 'post_tool_use', toolName: call.name, args: call.arguments, result: result.status === 'success' ? 'success' : result.status, ...(path === undefined ? {} : {filePath: path})});
    if (path !== undefined && (call.name === 'write_file' || call.name === 'edit_file')) await this.#hooks?.fire('file_change', {event: 'file_change', toolName: call.name, args: call.arguments, filePath: path});
  }
}
