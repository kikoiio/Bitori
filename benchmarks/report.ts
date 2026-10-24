#!/usr/bin/env npx tsx
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {RunLedger, TaskResult} from './types.js';

const resultsRoot = resolve(import.meta.dirname, 'results');
if (!existsSync(resultsRoot)) {
  console.error('暂无 benchmark 结果；先运行 npm run bench');
  process.exit(1);
}

const ledgers = readdirSync(resultsRoot)
  .filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join(resultsRoot, name), 'utf8')) as RunLedger)
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

if (ledgers.length === 0) {
  console.error('暂无 benchmark 结果；先运行 npm run bench');
  process.exit(1);
}

interface ModelKey {provider: string; model: string}
const key = ({provider, model}: ModelKey): string => `${provider}/${model}`;

// 按 model × task 聚合，比较不同模型的相对强弱。
const byModel = new Map<string, Map<string, TaskResult[]>>();
for (const ledger of ledgers) {
  const modelKey = key(ledger);
  const tasks = byModel.get(modelKey) ?? new Map<string, TaskResult[]>();
  byModel.set(modelKey, tasks);
  for (const result of ledger.results) {
    const runs = tasks.get(result.taskId) ?? [];
    runs.push(result);
    tasks.set(result.taskId, runs);
  }
}

console.log(`Benchmark 趋势（${ledgers.length} 次运行，${new Date(ledgers[0]!.startedAt).toISOString()} → ${new Date(ledgers.at(-1)!.startedAt).toISOString()}）\n`);

for (const [modelKey, tasks] of byModel) {
  console.log(`== ${modelKey} ==`);
  const taskIds = [...tasks.keys()].sort();
  for (const taskId of taskIds) {
    const runs = tasks.get(taskId)!;
    const passed = runs.filter(run => run.status === 'pass').length;
    const avgIterations = runs.reduce((sum, run) => sum + run.iterations, 0) / runs.length;
    const avgTokens = runs.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0) / runs.length;
    console.log(`${taskId.padEnd(24)} ${passed}/${runs.length}  平均迭代 ${avgIterations.toFixed(1)}  平均 tokens ${Math.round(avgTokens)}`);
  }
  const all = [...tasks.values()].flat();
  const passed = all.filter(run => run.status === 'pass').length;
  console.log(`总体 ${passed}/${all.length}（${Math.round((passed / all.length) * 100)}%）\n`);
}

// 时间轴：观察系统提示词 / provider 改动前后的回归。
console.log('== 逐次通过率 ==');
for (const ledger of ledgers) {
  const {passed, total} = ledger.summary;
  console.log(`${ledger.startedAt}  ${key(ledger)}  ${passed}/${total}（${Math.round((passed / total) * 100)}%）`);
}
