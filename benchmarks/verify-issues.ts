#!/usr/bin/env npx tsx
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const resultsRoot = resolve(import.meta.dirname, 'results');
const repo = 'kikoiio/Bitori';
const command = process.argv[2];
const token = process.env.GH_TOKEN;
if (!token) throw new Error('缺少 GH_TOKEN 环境变量');
const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`};
const markerPrefix = '<!-- bench-verify-started:';

interface IssueSummary {number: number; title: string; labels: Array<{name: string}>; pull_request?: unknown}

async function openBenchmarkIssues(): Promise<IssueSummary[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=benchmark&per_page=100`, {headers});
  if (!response.ok) throw new Error(`读取开放 Issue 失败：${response.status} ${await response.text()}`);
  return (await response.json() as IssueSummary[]).filter(issue => issue.pull_request === undefined);
}

async function verifiedWithin(issue: IssueSummary, hours: number): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issue.number}/comments?per_page=100`, {headers});
  if (!response.ok) throw new Error(`读取 Issue 评论失败：${issue.number} ${response.status}`);
  const comments = await response.json() as Array<{body: string | null}>;
  const cutoff = Date.now() - hours * 3_600_000;
  return comments.some(comment => {
    const match = comment.body?.match(/<!-- bench-verify-started: ([^>]+) -->/);
    return match?.[1] !== undefined && Date.parse(match[1]) > cutoff;
  });
}

async function comment(issueNumber: number, body: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({body}),
  });
  if (!response.ok) throw new Error(`评论 Issue 失败：${issueNumber} ${response.status} ${await response.text()}`);
}

if (command === 'plan') {
  const candidates: Array<{number: number; taskId: string}> = [];
  for (const issue of await openBenchmarkIssues()) {
    // provider 配额类失败不是任务回归，重跑没有意义。
    if (issue.labels.some(label => label.name === 'provider')) continue;
    const taskId = issue.title.match(/^\[benchmark\] (.+?) 未通过/)?.[1];
    if (taskId === undefined) continue;
    if (await verifiedWithin(issue, 24)) {
      console.log(`跳过（24 小时内已验证）：#${issue.number}`);
      continue;
    }
    candidates.push({number: issue.number, taskId});
  }
  const at = new Date().toISOString();
  for (const candidate of candidates) {
    await comment(candidate.number, `开始定向验证 \`${candidate.taskId}\`。\n\n${markerPrefix}${at} -->`);
  }
  process.stdout.write(JSON.stringify({tasks: candidates.map(item => item.taskId), issueNumbers: candidates.map(item => item.number)}) + '\n');
} else if (command === 'close') {
  const outcomeIndex = process.argv.indexOf('--outcome');
  const runIdIndex = process.argv.indexOf('--run-id');
  const runUrlIndex = process.argv.indexOf('--run-url');
  const outcome = outcomeIndex === -1 ? 'fail' : process.argv[outcomeIndex + 1];
  const runId = runIdIndex === -1 ? '(unknown)' : process.argv[runIdIndex + 1];
  const runUrl = runUrlIndex === -1 ? '' : process.argv[runUrlIndex + 1];
  const issueNumbers = process.argv.slice(3).filter(argument => /^\d+$/.test(argument)).map(Number);
  if (issueNumbers.length === 0) throw new Error('未指定 Issue 编号');
  for (const number of issueNumbers) {
    if (outcome === 'pass') {
      const closed = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
        method: 'PATCH',
        headers: {...headers, 'Content-Type': 'application/json'},
        body: JSON.stringify({state: 'closed'}),
      });
      if (!closed.ok) throw new Error(`关闭 Issue 失败：${number} ${closed.status}`);
      await comment(number, `定向验证通过（run \`${runId}\`${runUrl === '' ? '' : `，[日志](${runUrl})`}），自动关闭。`);
    } else {
      await comment(number, `定向验证仍未通过（run \`${runId}\`${runUrl === '' ? '' : `，[日志](${runUrl})`}），保持开放。`);
    }
  }
} else if (command === 'ledger-exists') {
  const runId = process.argv[3];
  if (runId === undefined) throw new Error('缺少 runId');
  try {
    readFileSync(join(resultsRoot, `${runId}.json`));
  } catch {
    process.exitCode = 1;
  }
} else {
  throw new Error('用法：tsx benchmarks/verify-issues.ts plan | close --outcome pass|fail --run-id <id> --run-url <url> <issue...>');
}
