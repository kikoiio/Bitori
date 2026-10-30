import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {DiffView} from '../../src/tui/components/diff-view.js';
import {ToolApprovalPanel} from '../../src/tui/components/tool-approval-panel.js';
import {ToolCallCard} from '../../src/tui/components/tool-call-card.js';
import {ToolCallList} from '../../src/tui/components/tool-call-list.js';
import type {ToolCallRecord} from '../../src/storage/types.js';

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'toolName'>): ToolCallRecord {
  return {
    sessionId: 's', assistantMessageId: 'm', providerCallId: 'p', position: 0, arguments: {},
    approvalStatus: 'not_required', executionStatus: 'succeeded', result: {status: 'success', output: {}},
    createdAt: 1, updatedAt: 1, ...partial,
  };
}

describe('工具 TUI 组件', () => {
  it('命令卡片显示圆点标题和输出摘要', () => {
    const rec = record({
      id: 'r', toolName: 'run_command', arguments: {command: 'echo hi'},
      approvalStatus: 'approved', result: {status: 'success', output: {exitCode: 0, stdout: 'hi', stderr: ''}},
    });
    const view = render(<ToolCallCard record={rec} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Bash(echo hi)');
    expect(frame).toContain('hi');
    expect(frame).toContain('●');
    view.unmount();
  });

  it('运行中的读取显示进行时动词', () => {
    const rec = record({id: 'r', toolName: 'read_file', arguments: {path: 'notes.txt'}, executionStatus: 'running', result: null});
    const view = render(<ToolCallCard record={rec} />);
    expect(view.lastFrame()).toContain('Reading notes.txt');
    view.unmount();
  });

  it('编辑卡片内联双行号 diff', () => {
    const rec = record({id: 'e', toolName: 'edit_file', arguments: {path: 'notes.txt', oldText: 'beta', newText: 'BETA\nepsilon'}});
    const view = render(<ToolCallCard record={rec} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Update(notes.txt)');
    expect(frame).toContain('新增 2 行，删除 1 行');
    expect(frame).toContain('-beta');
    expect(frame).toContain('+BETA');
    expect(frame).toContain('+epsilon');
    view.unmount();
  });

  it('折叠列表把连续读取压成摘要', () => {
    const records = [
      record({id: 'a', toolName: 'read_file', arguments: {path: 'a.ts'}}),
      record({id: 'b', toolName: 'read_file', arguments: {path: 'b.ts'}}),
      record({id: 'c', toolName: 'edit_file', arguments: {path: 'b.ts', oldText: 'x', newText: 'y'}}),
    ];
    const compact = render(<ToolCallList records={records} />);
    expect(compact.lastFrame()).toContain('读取 2 个文件');
    expect(compact.lastFrame()).toContain('Update(b.ts)');
    expect(compact.lastFrame()).not.toContain('Read(a.ts)');
    compact.unmount();
    const verbose = render(<ToolCallList records={records} forceExpanded />);
    expect(verbose.lastFrame()).toContain('Read(a.ts)');
    expect(verbose.lastFrame()).toContain('Read(b.ts)');
    verbose.unmount();
  });

  it('审批面板显示参数、编号选项和 Y/N', () => {
    const view = render(<ToolApprovalPanel prompt={{callId: 'c', toolName: 'run_command', effect: 'command', argumentSummary: '{"command":"echo hi"}', riskMessage: '批准的命令可能访问网络、启动子进程或影响工作区外资源。'}} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('echo hi');
    expect(frame).toContain('Y 批准');
    expect(frame).toContain('1. 是');
    expect(frame).toContain('访问网络');
    expect(frame).toContain('启动子进程');
    expect(frame).toContain('工作区外');
    view.unmount();
  });

  it('编辑审批复用 diff 渲染', () => {
    const view = render(<ToolApprovalPanel prompt={{callId: 'c', toolName: 'edit_file', effect: 'write', argumentSummary: '{"path":"notes.txt","oldText":"beta","newText":"BETA"}', riskMessage: null}} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('notes.txt');
    expect(frame).toContain('-beta');
    expect(frame).toContain('+BETA');
    view.unmount();
  });
});

describe('DiffView', () => {
  it('上下文行与增删行共用新/旧行号', () => {
    const view = render(<DiffView oldContent={'alpha\nbeta\ngamma'} newContent={'alpha\nBETA\ngamma'} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('1  alpha');
    expect(frame).toContain('-beta');
    expect(frame).toContain('+BETA');
    view.unmount();
  });
});
