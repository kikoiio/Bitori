import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {ToolApprovalPanel} from '../../src/tui/components/tool-approval-panel.js';
import {ToolCallCard} from '../../src/tui/components/tool-call-card.js';
import type {ToolCallRecord} from '../../src/storage/types.js';

const base: ToolCallRecord = {id: 'r', sessionId: 's', assistantMessageId: 'm', providerCallId: 'p', position: 0, toolName: 'run_command', arguments: {command: 'echo hi'}, approvalStatus: 'approved', executionStatus: 'succeeded', result: {status: 'success', output: {exitCode: 0}}, createdAt: 1, updatedAt: 1};
describe('工具 TUI 组件', () => {
  it.each(['queued', 'running', 'succeeded', 'failed', 'timed_out', 'skipped', 'interrupted'] as const)('显示执行状态 %s', status => { const view = render(<ToolCallCard record={{...base, executionStatus: status}} />); expect(view.lastFrame()).toContain('run_command'); expect(view.lastFrame()).toContain(status); expect(view.lastFrame()).toContain('echo hi'); view.unmount(); });
  it.each(['pending', 'approved', 'denied', 'not_required'] as const)('显示审批状态 %s', approvalStatus => { const view = render(<ToolCallCard record={{...base, approvalStatus}} />); expect(view.lastFrame()).toContain(approvalStatus); view.unmount(); });
  it('审批面板显示参数、Y/N 和完整命令风险', () => { const view = render(<ToolApprovalPanel prompt={{callId: 'c', toolName: 'run_command', effect: 'command', argumentSummary: '{"command":"echo hi"}', riskMessage: '批准的命令可能访问网络、启动子进程或影响工作区外资源。'}} />); const frame = view.lastFrame(); expect(frame).toContain('echo hi'); expect(frame).toContain('Y 批准'); expect(frame).toContain('访问网络'); expect(frame).toContain('启动子进程'); expect(frame).toContain('工作区外'); view.unmount(); });
});
