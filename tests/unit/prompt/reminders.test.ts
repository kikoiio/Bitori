import {describe, expect, it} from 'vitest';
import {buildReminders, PLAN_FULL_INTERVAL, SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN} from '../../../src/prompt/reminders.js';

describe('prompt reminders', () => {
  it('execute 模式不生成提醒', () => {
    expect(buildReminders('execute', 1)).toEqual([]);
    expect(buildReminders('execute', 5)).toEqual([]);
  });

  it('plan 模式第 1-5 轮节奏为完整、精简、精简、完整、精简', () => {
    const kinds = [1, 2, 3, 4, 5].map(turn => {
      const [reminder] = buildReminders('plan', turn);
      expect(reminder).toBeDefined();
      return reminder!.includes('只能使用只读工具进行探索和分析') ? 'full' : 'compact';
    });
    expect(kinds).toEqual(['full', 'compact', 'compact', 'full', 'compact']);
  });

  it('所有提醒均被标签包裹', () => {
    for (let turn = 1; turn <= 6; turn++) {
      const [reminder] = buildReminders('plan', turn);
      expect(reminder!.startsWith(SYSTEM_REMINDER_OPEN)).toBe(true);
      expect(reminder!.endsWith(SYSTEM_REMINDER_CLOSE)).toBe(true);
    }
  });

  it('精简提醒正文为单行', () => {
    const [compact] = buildReminders('plan', 2);
    const inner = compact!.slice(SYSTEM_REMINDER_OPEN.length, -SYSTEM_REMINDER_CLOSE.length).trim();
    expect(inner).not.toContain('\n');
  });

  it('完整轮间隔常量与节奏一致', () => {
    expect(PLAN_FULL_INTERVAL).toBe(3);
    expect(buildReminders('plan', 1 + PLAN_FULL_INTERVAL)[0]).toBe(buildReminders('plan', 1)[0]);
  });
});
