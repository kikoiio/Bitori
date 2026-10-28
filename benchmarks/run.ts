#!/usr/bin/env npx tsx
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parse as parseYaml} from 'yaml';
import type {RunLedger, TaskDefinition, TaskResult} from './types.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const tasksRoot = join(root, 'benchmarks', 'tasks');
const provider = process.env.BITORI_BENCH_PROVIDER ?? 'groq';
const model = process.env.BITORI_BENCH_MODEL ?? process.env.LLM_MODEL ?? '';
const profile = process.env.BITORI_BENCH_PROFILE ?? '';
const taskDelayMs = Number.parseInt(process.env.BITORI_BENCH_TASK_DELAY_MS ?? '15000', 10);
const onlyTasks = (process.env.BITORI_BENCH_TASKS ?? '').split(',').map(name => name.trim()).filter(name => name.length > 0);

function discoverTasks(): Array<{definition: TaskDefinition; directory: string}> {
  if (!existsSync(tasksRoot)) return [];
  const tasks = readdirSync(tasksRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const directory = join(tasksRoot, entry.name);
      const definition = parseYaml(readFileSync(join(directory, 'task.yaml'), 'utf8')) as TaskDefinition;
      if (definition.id !== entry.name) throw new Error(`任务目录与 id 不一致：${entry.name} / ${definition.id}`);
      return {definition, directory};
    })
    .filter(task => onlyTasks.length === 0 || onlyTasks.includes(task.definition.id))
    .sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  const missing = onlyTasks.filter(id => !tasks.some(task => task.definition.id === id));
  if (missing.length > 0) throw new Error(`未知 benchmark 任务：${missing.join(', ')}`);
  return tasks;
}

interface ExecSummary {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{name: string; status: string}>;
  reply: string;
  stopReason: string | null;
  error: string | null;
  errorMessage: string | null;
}

function parseExecSummary(stdout: string, stderr: string): ExecSummary {
  const fallback: ExecSummary = {iterations: 0, inputTokens: 0, outputTokens: 0, toolCalls: [], reply: '', stopReason: null, error: stderr || 'exec 未返回 JSON', errorMessage: null};
  const line = stdout.trimEnd().split('\n').at(-1);
  if (!line?.startsWith('{')) return fallback;
  try {
    const parsed = JSON.parse(line) as Partial<ExecSummary>;
    return {...fallback, ...parsed};
  } catch {
    return {...fallback, error: `exec JSON 解析失败：${line.slice(0, 200)}`};
  }
}

function violatedConstraints(task: TaskDefinition, summary: ExecSummary): string[] {
  const violations: string[] = [];
  for (const tool of task.forbiddenTools ?? []) {
    if (summary.toolCalls.some(call => call.name === tool)) violations.push(`禁止使用工具 ${tool}`);
  }
  if (task.expectReplyExact !== undefined && summary.reply.trim() !== task.expectReplyExact) violations.push(`回复应为 ${task.expectReplyExact}`);
  for (const expected of task.expectReplyContains ?? []) {
    if (!summary.reply.includes(expected)) violations.push(`回复应包含 ${expected}`);
  }
  const anyExpected = task.expectReplyAnyContains ?? [];
  if (anyExpected.length > 0 && !anyExpected.some(expected => summary.reply.includes(expected))) {
    violations.push(`回复应包含以下之一：${anyExpected.join(' / ')}`);
  }
  return violations;
}

async function verify(task: {definition: TaskDefinition; directory: string}, workspace: string): Promise<string | null> {
  try {
    await exec(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(task.directory, 'verify.ts')], {cwd: workspace, maxBuffer: 8 * 1024 * 1024});
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
  }
}

async function runTask(task: {definition: TaskDefinition; directory: string}): Promise<TaskResult> {
  const workspace = mkdtempSync(join(tmpdir(), `bitori-bench-${task.definition.id}-`));
  const source = join(task.directory, 'workspace');
  const started = Date.now();
  try {
    if (existsSync(source)) cpSync(source, workspace, {recursive: true});
    const args = [join(root, 'dist', 'bin', 'bitori.js'), 'exec', '--task', task.definition.task, '--workspace', workspace, '--json'];
    if (profile) args.push('--profile', profile);
    if (task.definition.maxIterations !== undefined) args.push('--max-iterations', String(task.definition.maxIterations));
    const invocation = await exec('node', args, {cwd: workspace, maxBuffer: 16 * 1024 * 1024})
      .then(output => ({stdout: output.stdout, stderr: output.stderr, exitCode: 0}))
      .catch((error: {code?: number; stdout?: string; stderr?: string}) => ({stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? 1}));
    const summary = parseExecSummary(invocation.stdout, invocation.stderr);
    const constraints = violatedConstraints(task.definition, summary);
    const verifyError = await verify(task, workspace);
    const agentError = invocation.exitCode !== 0 ? [...new Set([summary.error, summary.errorMessage].filter(item => item !== null))].join('\n') || invocation.stderr : null;
    const errors = [...new Set([agentError, ...constraints, verifyError].filter(item => item !== null))];
    const status: TaskResult['status'] = errors.length > 0 ? 'fail' : 'pass';
    return {
      taskId: task.definition.id,
      model,
      provider,
      status,
      exitCode: invocation.exitCode,
      exitReason: invocation.exitCode !== 0 ? 'agent' : verifyError !== null ? 'verify' : constraints.length > 0 ? 'constraint' : 'none',
      iterations: summary.iterations,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      toolSequence: summary.toolCalls.map(call => call.name),
      reply: summary.reply,
      error: errors.length > 0 ? errors.join('\n') : null,
      durationMs: Date.now() - started,
      attempts: 1,
    };
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function runTaskWithRateLimitRetry(task: {definition: TaskDefinition; directory: string}): Promise<TaskResult> {
  let result = await runTask(task);
  // 每日配额耗尽时继续跑只会烧时间；只有分钟级限流才值得重试。
  if (result.error !== null && /tokens per day/i.test(result.error)) {
    throw new Error('Groq 每日 token 配额已耗尽，终止本轮 benchmark');
  }
  if (result.status !== 'pass' && result.error !== null && /429|rate_limit/i.test(result.error)) {
    process.stderr.write('  429 限流，45 秒后重试一次\n');
    await sleep(45_000);
    result = await runTask(task);
    return {...result, attempts: 2};
  }
  return result;
}

if (!model) throw new Error('缺少 BITORI_BENCH_MODEL 或 LLM_MODEL');
const tasks = discoverTasks();
if (tasks.length === 0) throw new Error('未发现 benchmark 任务');
const startedAt = new Date().toISOString();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${provider}`;
const results: TaskResult[] = [];
for (const task of tasks) {
  if (results.length > 0 && taskDelayMs > 0) await sleep(taskDelayMs);
  process.stderr.write(`[${results.length + 1}/${tasks.length}] ${task.definition.id} ... `);
  const started = Date.now();
  try {
    results.push(await runTaskWithRateLimitRetry(task));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({taskId: task.definition.id, model, provider, status: 'error', exitCode: 1, exitReason: 'harness', iterations: 0, inputTokens: 0, outputTokens: 0, toolSequence: [], reply: '', error: message, durationMs: Date.now() - started, attempts: 1});
  }
  const result = results.at(-1)!;
  process.stderr.write(`${result.status} (${result.durationMs}ms)\n`);
}
const passed = results.filter(result => result.status === 'pass').length;
const ledger: RunLedger = {runId, startedAt, provider, model, results, summary: {passed, failed: results.filter(result => result.status === 'fail').length, errored: results.filter(result => result.status === 'error').length, total: results.length, passRate: passed / results.length}};
const outputDirectory = join(root, 'benchmarks', 'results');
mkdirSync(outputDirectory, {recursive: true});
writeFileSync(join(outputDirectory, `${runId}.json`), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
process.stdout.write(`${JSON.stringify({...ledger.summary, runId})}\n`);
process.exitCode = passed === results.length ? 0 : 1;
