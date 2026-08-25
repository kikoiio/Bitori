import {now} from '../shared/ids.js';
import type {SessionRepositoryContract, ToolCallRecord} from '../storage/types.js';
import type {AssembledToolBatch, ToolCall, ToolExecutionResult} from './types.js';
import type {ApprovalCoordinator} from './approval-coordinator.js';
import type {ToolExecutor} from './executor.js';

// [s02] records 以流内 internalId 为键；记录主键是独立 UUID，与流内 id 不再相同。
export interface ToolBatchContext {executor: ToolExecutor; approvals: ApprovalCoordinator; repository: SessionRepositoryContract; records: ReadonlyMap<string, ToolCallRecord>; signal: AbortSignal}

/** [s02] 只读分支并行，副作用分支严格按模型位置逐项审批、串行执行。 */
export class ToolBatchCoordinator {
  async execute(batch: AssembledToolBatch, context: ToolBatchContext): Promise<ToolCallRecord[]> {
    const byCall = new Map(context.records);
    const run = async (call: ToolCall): Promise<void> => {
      let record = byCall.get(call.internalId); if (!record) throw new Error(`缺少工具记录：${call.internalId}`);
      if (call.effect !== 'read') {
        const decision = await context.approvals.request(call);
        if (decision === 'denied') { const result: ToolExecutionResult = {status: 'denied', error: {code: 'denied', message: '用户拒绝了工具调用', retryable: false}}; record = {...record, approvalStatus: 'denied', executionStatus: 'skipped', result, updatedAt: now()}; byCall.set(call.internalId, record); await context.repository.updateToolCall(record); return; }
        record = {...record, approvalStatus: 'approved', updatedAt: now()}; byCall.set(call.internalId, record); await context.repository.updateToolCall(record);
      }
      record = {...record, executionStatus: 'running', updatedAt: now()}; byCall.set(call.internalId, record); await context.repository.updateToolCall(record);
      const result = await context.executor.execute(call, context.signal);
      const executionStatus = result.status === 'success' ? 'succeeded' : result.status === 'timeout' ? 'timed_out' : result.status === 'interrupted' ? 'interrupted' : 'failed';
      record = {...record, executionStatus, result, updatedAt: now()}; byCall.set(call.internalId, record); await context.repository.updateToolCall(record);
    };
    const reads = batch.validCalls.filter(call => call.effect === 'read').map(run);
    const sideEffects = (async () => { for (const call of batch.validCalls.filter(item => item.effect !== 'read').sort((a, b) => a.position - b.position)) await run(call); })();
    const settled = await Promise.allSettled([...reads, sideEffects]);
    const rejected = settled.find(result => result.status === 'rejected');
    // [s02] 状态写盘失败不能被当作成功继续回灌，尤其不能在批准未持久化时启动副作用。
    if (rejected?.status === 'rejected') throw rejected.reason;
    return [...byCall.values()].sort((a, b) => a.position - b.position);
  }
}
