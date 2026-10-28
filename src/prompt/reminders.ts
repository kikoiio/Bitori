import type {AgentMode} from '../agent/types.js';

/** 系统补充指令的包装标签；模型据此识别这不是用户输入，不应对其直接回复。 */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>';
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/** 把补充指令包装为带标签的提醒文本。 */
export function wrapSystemReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

/** Plan 模式下每隔多少轮重复一次完整指令。 */
export const PLAN_FULL_INTERVAL = 3;

/** Plan 模式首轮与重复轮注入的完整指令。 */
const PLAN_FULL_INSTRUCTION = '当前会话处于 Plan 模式。在此模式下你只能使用只读工具进行探索和分析：不得修改、创建或删除任何文件，也不得执行命令。请充分阅读和理解相关代码后，产出一份清晰、可执行的实施计划；用户确认后会切回 DO 模式执行该计划。这是系统补充指令，不是用户输入，请继续按上述约束回应用户的任务，不要直接回复本提醒。';

/** Plan 模式非完整轮注入的一行精简提醒。 */
const PLAN_COMPACT_INSTRUCTION = '仍处于 Plan 模式：保持只读，继续探索并产出计划，不要修改或执行。此为系统补充指令，无需回复。';

/**
 * 按会话模式与轮次生成需要注入的提醒文本（已含标签）。
 * Plan 模式从第 1 轮起每隔 PLAN_FULL_INTERVAL 轮注入完整指令，其余轮次注入一行精简提醒；
 * execute 模式不注入任何提醒。提醒内容只由模式与轮次决定，重放时可确定性重建。
 */
export function buildReminders(mode: AgentMode, turnIndex: number): string[] {
  if (mode !== 'plan') return [];
  const full = (turnIndex - 1) % PLAN_FULL_INTERVAL === 0;
  return [wrapSystemReminder(full ? PLAN_FULL_INSTRUCTION : PLAN_COMPACT_INSTRUCTION)];
}
