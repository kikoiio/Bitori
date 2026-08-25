import {describe, expect, it} from 'vitest';
import {FIXED_SECTIONS} from '../../../src/prompt/sections.js';

describe('prompt sections', () => {
  it('恰好七个固定模块，优先级严格递增且符合预定编号', () => {
    expect(FIXED_SECTIONS).toHaveLength(7);
    expect(FIXED_SECTIONS.map(section => section.priority)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('工具使用模块包含三条关键规则', () => {
    const toolUsage = FIXED_SECTIONS.find(section => section.id === 'tool_usage');
    expect(toolUsage).toBeDefined();
    expect(toolUsage!.text).toContain('优先使用专用工具');
    expect(toolUsage!.text).toContain('编辑任何文件前必须先用 read_file 读取');
    expect(toolUsage!.text).toContain('不要猜测文件路径');
  });

  it('系统约束模块包含工作区边界与审批规则', () => {
    const constraints = FIXED_SECTIONS.find(section => section.id === 'system_constraints');
    expect(constraints).toBeDefined();
    expect(constraints!.text).toContain('工作区');
    expect(constraints!.text).toContain('批准');
  });
});
