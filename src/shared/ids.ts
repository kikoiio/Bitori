import {randomUUID} from 'node:crypto';

/** [s01] 数据库主键使用随机 UUID，避免依赖数据库自增编号。 */
export function createId(): string {
  return randomUUID();
}

/** [s02] 工具调用使用独立入口，便于跨流、审批、存储和结果追踪。 */
export function createToolCallId(): string {
  return randomUUID();
}

/** [s01] 时间统一存成 Unix 毫秒数，便于排序和序列化。 */
export function now(): number {
  return Date.now();
}
