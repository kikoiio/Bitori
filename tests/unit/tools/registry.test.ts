import {describe, expect, it} from 'vitest';
import {ToolRegistry} from '../../../src/tools/registry.js';
import {MockTool} from '../../helpers/mock-tool.js';

describe('ToolRegistry', () => {
  it('保持顺序、按名查找且定义来自单一登记', () => { const registry = new ToolRegistry(); const a = new MockTool('a'); const b = new MockTool('b'); registry.register(a); registry.register(b); expect(registry.entries()).toEqual([a, b]); expect(registry.get('a')).toBe(a); expect(registry.get('missing')).toBeUndefined(); expect(registry.definitions().map(item => item.name)).toEqual(['a', 'b']); });
  it('拒绝重复名称', () => { const registry = new ToolRegistry(); registry.register(new MockTool('same')); expect(() => registry.register(new MockTool('same'))).toThrow(/重复/); });
});
