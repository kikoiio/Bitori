import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
mkdirSync(join(root, '.tmp'), {recursive: true});

test('验证器拒绝篡改测试和 npm 脚本', () => {
  const dir = mkdtempSync(join(root, '.tmp/bench-assets-'));
  try {
    cpSync(join(root, 'benchmarks/tasks/fix-failing-test/workspace'), dir, {recursive: true});
    writeFileSync(join(dir, 'index.js'), 'export function add(a, b) { return a + b; }\n');
    const run = () => spawnSync(process.execPath, [tsx, join(root, 'benchmarks/tasks/fix-failing-test/verify.ts')], {cwd: dir, encoding: 'utf8'});
    assert.equal(run().status, 0);
    writeFileSync(join(dir, 'index.test.js'), '');
    assert.notEqual(run().status, 0);
    cpSync(join(root, 'benchmarks/tasks/fix-failing-test/workspace/index.test.js'), join(dir, 'index.test.js'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module","scripts":{"test":"true"}}');
    assert.notEqual(run().status, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('可修改测试的任务仍须满足独立行为断言', () => {
  const dir = mkdtempSync(join(root, '.tmp/bench-flaky-'));
  try {
    cpSync(join(root, 'benchmarks/tasks/fix-flaky-test/workspace'), dir, {recursive: true});
    writeFileSync(join(dir, 'scheduler.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {nextDelayMs} from './scheduler.js'; test('cap', () => assert.ok(nextDelayMs(1) <= 10000)); test('grows', () => assert.ok(nextDelayMs(100) > 100));");
    const run = () => spawnSync(process.execPath, [tsx, join(root, 'benchmarks/tasks/fix-flaky-test/verify.ts')], {cwd: dir, encoding: 'utf8'});
    writeFileSync(join(dir, 'scheduler.js'), 'export const nextDelayMs = n => Math.min(n * 2, 10000);');
    assert.equal(run().status, 0);
    writeFileSync(join(dir, 'scheduler.js'), 'export const nextDelayMs = n => n * 2;');
    assert.notEqual(run().status, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('未知任务不能被其他有效任务掩盖', () => {
  const result = spawnSync(process.execPath, [tsx, join(root, 'benchmarks/run.ts')], {cwd: root, encoding: 'utf8', env: {...process.env, BITORI_BENCH_MODEL: 'test', BITORI_BENCH_TASKS: 'fix-failing-test,unknown-task'}});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未知 benchmark 任务：unknown-task/);
});

test('计划隔离普通 issue，stdout 可解析，关闭只依据对应 ledger', () => {
  const dir = mkdtempSync(join(root, '.tmp/bench-issues-'));
  try {
    const issue = (number, title, labels = ['benchmark']) => ({number, title, body: 'Model: `test-model` (groq)', state: 'open', labels: labels.map(name => ({name}))});
    const issues = [issue(1, '[benchmark] fix-failing-test 未通过'), issue(2, '普通 issue', []), issue(3, '[benchmark] unknown-task 未通过'), issue(4, '[benchmark] refactor-rename 未通过')];
    writeFileSync(join(dir, 'issues.json'), JSON.stringify(issues));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({pull_request: {body: '#1 #2 #3 #4'}}));
    writeFileSync(join(dir, 'mock.mjs'), `import {readFileSync, appendFileSync} from 'node:fs';\nconst issues = JSON.parse(readFileSync(process.env.MOCK_DIR + '/issues.json'));\nglobalThis.fetch = async (url, init = {}) => { const path = new URL(url).pathname; appendFileSync(process.env.MOCK_DIR + '/calls', (init.method || 'GET') + ' ' + path + '\\n'); const number = Number(path.match(/\\/issues\\/(\\d+)/)?.[1]); let body = path.endsWith('/comments') ? (init.method === 'POST' ? {} : number === 4 ? [{body: '<!-- bench-verify-started: ' + new Date().toISOString() + ' -->'}] : []) : number ? issues.find(i => i.number === number) : issues; return new Response(JSON.stringify(body), {status: body ? 200 : 404}); };\n`);
    const run = (command, extra = {}, args = []) => spawnSync(process.execPath, ['--import', 'tsx', '--import', join(dir, 'mock.mjs'), join(root, 'benchmarks/verify-issues.ts'), command, ...args], {cwd: root, encoding: 'utf8', env: {...process.env, GH_TOKEN: 'test', MOCK_DIR: dir, ...extra}});
    const pr = run('plan', {GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(dir, 'event.json')});
    assert.equal(pr.status, 0, pr.stderr);
    const plan = JSON.parse(pr.stdout);
    assert.deepEqual(plan, [{number: 1, taskId: 'fix-failing-test', model: 'test-model', provider: 'groq'}, {number: 4, taskId: 'refactor-rename', model: 'test-model', provider: 'groq'}]);
    const schedule = run('plan', {GITHUB_EVENT_NAME: 'schedule'});
    assert.equal(schedule.status, 0, schedule.stderr);
    assert.deepEqual(JSON.parse(schedule.stdout), [{number: 1, taskId: 'fix-failing-test', model: 'test-model', provider: 'groq'}]);
    assert.match(schedule.stderr, /跳过/);
    writeFileSync(join(dir, 'testrun.json'), JSON.stringify({runId: 'testrun', model: 'test-model', provider: 'groq', results: [{taskId: 'fix-failing-test', status: 'pass'}, {taskId: 'refactor-rename', status: 'fail'}]}));
    writeFileSync(join(dir, 'calls'), '');
    const env = {BITORI_VERIFY_PLAN: JSON.stringify(plan), BITORI_BENCH_RESULTS_DIR: dir, GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/master', GITHUB_DEFAULT_BRANCH: 'master'};
    const finish = run('finish', env, ['testrun']);
    assert.equal(finish.status, 0, finish.stderr);
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    assert.match(calls, /PATCH .*\/issues\/1\n/);
    assert.doesNotMatch(calls, /PATCH .*\/issues\/(2|3|4)\n/);
    assert.notEqual(run('finish', {...env, GITHUB_EVENT_NAME: 'pull_request'}, ['testrun']).status, 0);
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'testrun.json'), JSON.stringify({runId: 'testrun', model: 'other-model', provider: 'groq', results: [{taskId: 'fix-failing-test', status: 'pass'}]}));
    assert.equal(run('finish', env, ['testrun']).status, 0);
    assert.doesNotMatch(readFileSync(join(dir, 'calls'), 'utf8'), /PATCH /);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
