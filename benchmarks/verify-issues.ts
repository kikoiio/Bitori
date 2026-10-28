#!/usr/bin/env npx tsx
import {readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {z} from 'zod';

const root = resolve(import.meta.dirname);
const repo = process.env.GITHUB_REPOSITORY ?? 'kikoiio/Bitori';
const token = process.env.GH_TOKEN;
if (!token) throw new Error('缺少 GH_TOKEN 环境变量');
const headers = {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`};
const issueSchema = z.object({number: z.number().int().positive(), title: z.string(), body: z.string().nullable(), state: z.string(), labels: z.array(z.object({name: z.string()})), pull_request: z.unknown().optional()});
const planSchema = z.array(z.object({number: z.number().int().positive(), taskId: z.string().regex(/^[a-z0-9-]+$/), model: z.string().min(1), provider: z.string().min(1)}));
const ledgerSchema = z.object({runId: z.string(), model: z.string(), provider: z.string(), results: z.array(z.object({taskId: z.string(), status: z.enum(['pass', 'fail', 'error'])}))});
const taskIds = new Set(readdirSync(join(root, 'tasks'), {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name));

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {...init, headers: {...headers, 'Content-Type': 'application/json'}});
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function mapping(value: unknown): z.infer<typeof planSchema>[number] | undefined {
  const issue = issueSchema.parse(value);
  const taskId = issue.title.match(/^\[benchmark\] ([a-z0-9-]+) 未通过/)?.[1];
  const modelInfo = issue.body?.match(/^Model: `([^`\r\n]+)` \(([^)\r\n]+)\)$/m);
  const model = modelInfo?.[1];
  const provider = modelInfo?.[2];
  if (model === undefined || provider === undefined || issue.pull_request !== undefined || issue.state !== 'open' || !issue.labels.some(label => label.name === 'benchmark') || issue.labels.some(label => label.name === 'provider') || taskId === undefined || !taskIds.has(taskId)) return undefined;
  return {number: issue.number, taskId, model, provider};
}

async function comment(number: number, body: string): Promise<void> {
  await request(`/issues/${number}/comments`, {method: 'POST', body: JSON.stringify({body})});
}

async function recent(number: number): Promise<boolean> {
  for (let page = 1; ; page++) {
    const comments = z.array(z.object({body: z.string().nullable()})).parse(await request(`/issues/${number}/comments?per_page=100&page=${page}`));
    if (comments.some(item => {
      const timestamp = item.body?.match(/<!-- bench-verify-started: ([^>]+) -->/)?.[1];
      return timestamp !== undefined && Date.parse(timestamp) > Date.now() - 24 * 3_600_000;
    })) return true;
    if (comments.length < 100) return false;
  }
}

const command = process.argv[2];
if (command === 'plan') {
  const candidates: z.infer<typeof planSchema> = [];
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const event = z.object({pull_request: z.object({body: z.string().nullable()})}).parse(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')));
    const numbers = new Set(Array.from((event.pull_request.body ?? '').matchAll(/#(\d+)\b/g), match => Number(match[1])));
    for (const number of numbers) {
      const candidate = mapping(await request(`/issues/${number}`));
      if (candidate !== undefined) candidates.push(candidate);
    }
  } else {
    for (let page = 1; ; page++) {
      const issues = z.array(issueSchema).parse(await request(`/issues?state=open&labels=benchmark&per_page=100&page=${page}`));
      for (const issue of issues) {
        const candidate = mapping(issue);
        if (candidate === undefined) continue;
        if (await recent(candidate.number)) { process.stderr.write(`跳过（24 小时内已验证）：#${candidate.number}\n`); continue; }
        candidates.push(candidate);
      }
      if (issues.length < 100) break;
    }
  }
  process.stdout.write(`${JSON.stringify(candidates)}\n`);
} else if (command === 'start' || command === 'finish') {
  const plan = planSchema.parse(JSON.parse(process.env.BITORI_VERIFY_PLAN ?? ''));
  if (command === 'start') {
    for (const candidate of plan) await comment(candidate.number, `开始定向验证 \`${candidate.taskId}\`。\n\n<!-- bench-verify-started: ${new Date().toISOString()} -->`);
  } else {
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' || process.env.GITHUB_REF !== `refs/heads/${process.env.GITHUB_DEFAULT_BRANCH}`) throw new Error('只允许默认分支验证后关闭 Issue');
    const runId = process.argv[3] ?? '';
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('无效 runId');
    const ledger = ledgerSchema.parse(JSON.parse(readFileSync(join(process.env.BITORI_BENCH_RESULTS_DIR ?? join(root, 'results'), `${runId}.json`), 'utf8')));
    if (ledger.runId !== runId) throw new Error('ledger runId 不匹配');
    for (const candidate of plan) {
      const current = mapping(await request(`/issues/${candidate.number}`));
      if (current?.taskId !== candidate.taskId || current.model !== candidate.model || current.provider !== candidate.provider) { process.stderr.write(`Issue #${candidate.number} 已变化，跳过\n`); continue; }
      const matches = ledger.results.filter(result => result.taskId === candidate.taskId);
      const passed = ledger.model === candidate.model && ledger.provider === candidate.provider && matches.length === 1 && matches[0]?.status === 'pass';
      const runUrl = process.env.BITORI_RUN_URL ?? '';
      await comment(candidate.number, `定向验证${passed ? '通过' : '未通过或缺少结果'}（run \`${runId}\`${runUrl ? `，[日志](${runUrl})` : ''}），${passed ? '自动关闭' : '保持开放'}。`);
      if (passed) await request(`/issues/${candidate.number}`, {method: 'PATCH', body: JSON.stringify({state: 'closed'})});
    }
  }
} else {
  throw new Error('用法：tsx benchmarks/verify-issues.ts plan | start | finish <runId>');
}
