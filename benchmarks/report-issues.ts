#!/usr/bin/env npx tsx
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {RunLedger, TaskResult} from './types.js';

const resultsRoot = resolve(import.meta.dirname, 'results');
const runId = process.argv[2];
if (!runId) throw new Error('用法：tsx benchmarks/report-issues.ts <runId>');
const ledger = JSON.parse(readFileSync(join(resultsRoot, `${runId}.json`), 'utf8')) as RunLedger;
const token = process.env.GH_TOKEN;
if (!token) throw new Error('缺少 GH_TOKEN 环境变量');

function signature(result: TaskResult): string {
  const reason = result.exitReason === 'verify' ? 'verify-failed' : result.exitReason === 'constraint' ? 'constraint-violated' : (result.error ?? result.exitReason).slice(0, 120);
  return `bench:${result.taskId}:${reason}`;
}

/** 失败分诊：Issue 自带标签，打开就知道该修哪一层。 */
function triageLabels(result: TaskResult): string[] {
  if (result.error !== null && /429|rate limit|quota/i.test(result.error)) return ['provider'];
  if (result.error !== null && /iteration_limit/i.test(result.error)) return ['model-limit'];
  if (result.exitReason === 'constraint' && result.error !== null && result.error.includes('禁止使用工具')) return ['agent-behavior'];
  if (result.exitReason === 'constraint') return ['task-assertion'];
  if (result.exitReason === 'verify' && result.toolSequence.length === 0) return ['agent-behavior'];
  if (result.exitReason === 'verify') return ['needs-triage'];
  return ['agent-behavior'];
}

const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`};
const openResponse = await fetch('https://api.github.com/repos/kikoiio/Bitori/issues?state=open&labels=benchmark&per_page=100', {headers});
if (!openResponse.ok) throw new Error(`读取开放 Issue 失败：${openResponse.status} ${await openResponse.text()}`);
const openIssues = await openResponse.json() as Array<{title: string; body: string | null}>;

for (const result of ledger.results.filter(item => item.status !== 'pass')) {
  const mark = signature(result);
  const title = `[benchmark] ${result.taskId} 未通过（${result.status}）`;
  if (openIssues.some(issue => issue.body?.includes(`Signature: \`${mark}\``))) {
    console.log(`跳过（已有 Issue）：${mark}`);
    continue;
  }
  const body = [
    `Run: \`${ledger.runId}\``,
    `Model: \`${ledger.model}\` (${ledger.provider})`,
    `Signature: \`${mark}\``,
    '',
    `- exit=${result.exitCode} reason=${result.exitReason}`,
    `- iterations=${result.iterations} tokens=${result.inputTokens}/${result.outputTokens}`,
    `- tools=${result.toolSequence.join(' -> ') || '(none)'}`,
    `- duration=${result.durationMs}ms`,
    '',
    '## Error', '```', result.error ?? '(none)', '```',
    '', '## Reply', '```', result.reply || '(empty)', '```',
  ].join('\n');
  const created = await fetch('https://api.github.com/repos/kikoiio/Bitori/issues', {
    method: 'POST',
    headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({title, body, labels: ['benchmark', ...triageLabels(result)]}),
  });
  if (!created.ok) throw new Error(`创建 Issue 失败：${created.status} ${await created.text()}`);
  console.log(`已创建 Issue：${title}`);
}
