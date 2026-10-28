import {existsSync, readFileSync} from 'node:fs';
import {getLogger} from '../shared/logger.js';
import type {TraceEvent} from './types.js';

const logger = getLogger('trace');

export interface TraceReadResult {
  events: TraceEvent[];
  /** 无法解析的行数；损坏行跳过不中断读取。 */
  corruptLines: number;
}

/** 读取会话 trace 文件；每行一个 JSON，坏行跳过并计数。 */
export function readTraceFile(path: string): TraceReadResult {
  if (!existsSync(path)) return {events: [], corruptLines: 0};
  const events: TraceEvent[] = [];
  let corruptLines = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      corruptLines += 1;
    }
  }
  if (corruptLines > 0) logger.warn('trace 文件存在损坏行', {path, corruptLines});
  return {events, corruptLines};
}

export interface TraceIteration {
  iteration: number;
  iterationId: string;
  request?: Extract<TraceEvent, {type: 'request_prepared'}>;
  response?: Extract<TraceEvent, {type: 'response'}>;
  composition?: Extract<TraceEvent, {type: 'context_composition'}>;
  retries: Array<Extract<TraceEvent, {type: 'request_retry'}>>;
}

/** 按 iteration 分组，保留出现顺序。 */
export function groupByIteration(events: readonly TraceEvent[]): TraceIteration[] {
  const map = new Map<number, TraceIteration>();
  const ensure = (iteration: number, iterationId: string): TraceIteration => {
    let entry = map.get(iteration);
    if (entry === undefined) {
      entry = {iteration, iterationId, retries: []};
      map.set(iteration, entry);
    }
    return entry;
  };
  for (const event of events) {
    switch (event.type) {
      case 'request_prepared': {
        ensure(event.iteration, event.iterationId).request = event;
        break;
      }
      case 'response': {
        ensure(event.iteration, event.iterationId).response = event;
        break;
      }
      case 'context_composition': {
        ensure(event.iteration, event.iterationId).composition = event;
        break;
      }
      case 'request_retry': {
        ensure(event.iteration, event.iterationId).retries.push(event);
        break;
      }
      default:
        break;
    }
  }
  return [...map.values()].sort((a, b) => a.iteration - b.iteration);
}
