/**
 * 真实 Provider 端到端验收(显式开启,避免 CI 误跑产生费用):
 *   BITORI_E2E_PROVIDERS=1 npm run test:e2e:providers
 * 环境变量:
 *   BITORI_E2E_PROTOCOL  qoder | openai-chat | openai-responses | anthropic (默认 qoder)
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  该协议的凭据、端点与模型
 *   BITORI_E2E_MAX_CREDITS (默认 5)  credits 预算;token 协议用 BITORI_E2E_MAX_TOKENS(默认 300000)
 * 流程:临时工作区 → 读文件 → pwd → write_file → cat 校验 → 最终回答;
 * 输出写入 evaluation/results/e2e-providers/,全程脱敏,不打印密钥。
 */
import {config as loadDotenv} from 'dotenv';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir, homedir} from 'node:os';
import {createApplicationRuntime} from '../../src/app/runtime.js';
import {inferProtocol} from '../../src/config/protocol.js';
import {redactSecrets} from '../../src/config/secrets.js';
import type {AppConfig, ProviderProfile, Protocol} from '../../src/config/types.js';

loadDotenv({path: join(homedir(), '.bitori', '.env')});

if (process.env['BITORI_E2E_PROVIDERS'] !== '1') {
  console.error('需要显式 BITORI_E2E_PROVIDERS=1 才会运行真实网络测试(避免意外计费)。');
  process.exit(2);
}

const env = process.env;
// 协议可以显式指定；不指定时按地址与密钥形状推断，和 ~/.bitori/config.yaml 的规则一致。
const requestedProtocol = process.env['BITORI_E2E_PROTOCOL']?.trim();
const protocol = (requestedProtocol === undefined || requestedProtocol === ''
  ? inferProtocol({
    baseUrl: env['E2E_BASE_URL'] ?? env['LLM_BASE_URL'] ?? '',
    apiKey: env['E2E_API_KEY'] ?? env['LLM_API_KEY'] ?? '',
  }).protocol
  : requestedProtocol) as Protocol;
// 变量优先级:E2E_*(显式)> 协议专用(OPENROUTER_* 用于 openai-chat)> 通用 LLM_*。
const apiKey = env['E2E_API_KEY'] ?? (protocol === 'openai-chat' ? env['OPENROUTER_API_KEY'] : undefined) ?? env['LLM_API_KEY'] ?? '';
const baseUrl = env['E2E_BASE_URL'] ?? (protocol === 'openai-chat' ? env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1' : undefined) ?? env['LLM_BASE_URL'] ?? '';
const model = env['E2E_MODEL'] ?? (protocol === 'openai-chat' ? env['OPENROUTER_MODEL'] : undefined) ?? env['LLM_MODEL'] ?? '';
if (!apiKey || !model || (protocol !== 'anthropic' && !baseUrl)) {
  console.error('缺少 LLM_API_KEY / LLM_MODEL(qoder 与 OpenAI 兼容还需 LLM_BASE_URL)。');
  process.exit(2);
}

const maxCredits = Number(process.env['BITORI_E2E_MAX_CREDITS'] ?? '5');
const maxTokens = Number(process.env['BITORI_E2E_MAX_TOKENS'] ?? '300000');

const profile: ProviderProfile = {
  name: 'e2e', protocol, model, baseUrl, apiKey, thinking: {type: 'disabled'},
};
const config: AppConfig = {profiles: [profile], mcpServers: {}, models: {}, logging: {level: 'warn'}, trace: {}};

const workspace = mkdtempSync(join(tmpdir(), 'bitori-e2e-'));
const notePath = join(workspace, 'note.txt');
const planPath = join(workspace, 'plan.txt');
writeFileSync(notePath, 'Bitori E2E source line\nsecond line\n');

function safeLine(text: string): string {
  return redactSecrets(text, [profile]).replaceAll(apiKey, '<REDACTED_KEY>');
}

type Preset = 'loop' | 'fix-test' | 'add-test' | 'refactor';
const preset = ((process.env['BITORI_E2E_PRESET'] ?? 'loop') as Preset);

function setupPreset(): {task: string; verify: () => boolean} {
  if (preset === 'fix-test') {
    writeFileSync(join(workspace, 'math.mjs'), 'export function double(n) {\n  return n * 3; // BUG: 应为 n * 2\n}\n', 'utf8');
    writeFileSync(join(workspace, 'math.test.mjs'), 'import {test} from \u0027node:test\u0027;\nimport assert from \u0027node:assert/strict\u0027;\nimport {double} from \u0027./math.mjs\u0027;\ntest(\u0027double\u0027, () => { assert.equal(double(2), 4); });\n', 'utf8');
    return {
      task: `临时项目 ${workspace} 里有一个失败的测试。步骤:1) 用 run_command 执行 \`cd ${workspace} && node --test\` 复现失败;2) 用 read_file 看 math.mjs 与 math.test.mjs;3) 用 edit_file 修复 math.mjs 的实现(不要改测试断言);4) 再次 run_command \`cd ${workspace} && node --test\` 确认通过;5) 最后只回答:FIXED`,
      verify: () => {
        try {
          const source = readFileSync(join(workspace, 'math.mjs'), 'utf8');
          return /return\s+n\s*\*\s*2/.test(source) && !source.includes('* 3');
        } catch { return false; }
      },
    };
  }
  if (preset === 'add-test') {
    writeFileSync(join(workspace, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
    return {
      task: `临时项目 ${workspace} 的 math.mjs 缺少测试。步骤:1) read_file math.mjs;2) 用 write_file 新建 ${join(workspace, 'math.add.test.mjs')},用 node:test 与 node:assert/strict 覆盖 add(2,3)=5 和 add(-1,1)=0;3) 用 run_command \`cd ${workspace} && node --test\` 确认通过;4) 最后只回答:ADDED`,
      verify: () => existsSync(join(workspace, 'math.add.test.mjs')) && readFileSync(join(workspace, 'math.add.test.mjs'), 'utf8').includes('add('),
    };
  }
  if (preset === 'refactor') {
    writeFileSync(join(workspace, 'utils.mjs'), 'export function sumEvens(nums) {\n  let total = 0;\n  for (const n of nums) {\n    if (n % 2 === 0) total += n;\n  }\n  return total;\n}\n\nexport function countEvens(nums) {\n  let total = 0;\n  for (const n of nums) {\n    if (n % 2 === 0) total += 1;\n  }\n  return total;\n}\n', 'utf8');
    writeFileSync(join(workspace, 'verify.mjs'), 'import {sumEvens, countEvens} from \u0027./utils.mjs\u0027;\nimport assert from \u0027node:assert/strict\u0027;\nassert.equal(sumEvens([1, 2, 3, 4]), 6);\nassert.equal(countEvens([1, 2, 3, 4]), 2);\nconsole.log(\u0027verify-ok\u0027);\n', 'utf8');
    return {
      task: `项目 ${workspace}/utils.mjs 里 sumEvens 与 countEvens 重复遍历逻辑。做一次小重构:1) read_file utils.mjs;2) edit_file 提取共享的偶数遍历辅助函数,两个导出函数保持行为与签名不变;3) run_command \`cd ${workspace} && node verify.mjs\` 确认输出 verify-ok;4) 最后只回答:REFACTORED`,
      verify: () => {
        const source = readFileSync(join(workspace, 'utils.mjs'), 'utf8');
        return source.includes('export function sumEvens') && source.includes('export function countEvens') && (source.match(/n % 2 === 0/g)?.length ?? 0) <= 1;
      },
    };
  }
  return {
    task: [
      '这是一个端到端验收任务,请严格按步骤执行:',
      `1. 用 read_file 读取 ${notePath};`,
      `2. 用 run_command 执行 pwd;`,
      `3. 用 write_file 写入 ${planPath},内容为 note.txt 的第一行,再另起一行写 E2E-OK;`,
      `4. 用 run_command 执行 cat ${planPath} 校验;`,
      '5. 最后只回答:E2E DONE。',
    ].join('\n'),
    verify: () => existsSync(planPath) && readFileSync(planPath, 'utf8').includes('E2E-OK') && readFileSync(planPath, 'utf8').startsWith('Bitori E2E source line'),
  };
}

const presetRun = setupPreset();
const task = presetRun.task;
const markerWords: Record<Preset, string> = {loop: 'E2E DONE', 'fix-test': 'FIXED', 'add-test': 'ADDED', refactor: 'REFACTORED'};

interface Evidence {
  at: string;
  commitSha: string | null;
  workingTreeClean: boolean | null;
  preset: string;
  protocol: string;
  model: string;
  status: string;
  stopReason: string | null;
  iterations: number;
  toolCalls: Array<{name: string; approval: string; execution: string}>;
  usage: {inputTokens: number; outputTokens: number; credits?: number};
  reply: string;
  planFileMatches: boolean;
  budgetExceeded: boolean;
  visibleError: string | null;
  passed: boolean;
}

async function main(): Promise<number> {
  let revision = env['GITHUB_ACTIONS'] === 'true' ? env['GITHUB_SHA']?.trim() : undefined;
  let workingTreeClean: boolean | null = null;
  if (env['GITHUB_ACTIONS'] !== 'true') {
    try {
      revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: join(import.meta.dirname, '..', '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        maxBuffer: 1024,
      }).trim();
    } catch {
      revision = undefined;
    }
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: join(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      maxBuffer: 16_384,
    });
    workingTreeClean = status.length === 0;
  } catch {
    // Leave the field null when Git status is unavailable.
  }
  const commitSha = revision !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision) ? revision : null;
  const runtime = await createApplicationRuntime({config, profileName: 'e2e', workspace, databasePath: join(workspace, '.bitori', 'bitori.db'), maxIterations: 12});
  const {controller} = runtime;
  const unwatch = controller.subscribe(state => {
    if (state.approvalPrompt) controller.resolveToolApproval('approved_session');
  });
  const started = Date.now();
  try {
    await controller.sendMessage(task);
  } finally {
    unwatch();
    await runtime.close();
  }
  const state = controller.getState();
  const usage = state.runUsage;
  const budgetExceeded = (usage.credits ?? 0) > maxCredits || (usage.inputTokens + usage.outputTokens) > maxTokens;
  const planOk = presetRun.verify();
  const reply = [...state.messages].findLast(message => message.role === 'assistant')?.content ?? '';
  const names = state.toolCalls.map(call => call.toolName);
  const passed = state.requestStatus !== 'failed'
    && !budgetExceeded
    && planOk
    && reply.includes(markerWords[preset])
    && (usage.inputTokens + usage.outputTokens > 0 || (usage.credits ?? 0) > 0)
    && names.some(name => name === 'read_file' || name === 'edit_file' || name === 'write_file');
  const evidence: Evidence = {
    at: new Date().toISOString(),
    commitSha,
    workingTreeClean,
    preset,
    protocol,
    model,
    status: state.requestStatus,
    stopReason: state.stopReason,
    iterations: state.iteration,
    toolCalls: state.toolCalls.map(call => ({name: call.toolName, approval: call.approvalStatus, execution: call.executionStatus})),
    usage,
    reply: safeLine(reply).slice(0, 400),
    planFileMatches: planOk,
    budgetExceeded,
    visibleError: state.visibleError === null ? null : safeLine(state.visibleError),
    passed,
  };
  const outDir = env['BITORI_E2E_RESULTS_DIR'] === undefined
    ? join(import.meta.dirname, '..', '..', 'evaluation', 'results', 'e2e-providers')
    : resolve(env['BITORI_E2E_RESULTS_DIR']);
  mkdirSync(outDir, {recursive: true});
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 10)}-${protocol}${preset === 'loop' ? '' : `-${preset}`}.json`);
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${safeLine([
    `[e2e:${protocol}/${preset}] ${passed ? 'PASS' : 'FAIL'} (${Math.round((Date.now() - started) / 1000)}s)`,
    `  状态 ${evidence.status} · 停止 ${evidence.stopReason ?? '-'} · 迭代 ${evidence.iterations}`,
    `  工具 ${evidence.toolCalls.map(call => `${call.name}:${call.execution}`).join(', ') || '无'}`,
    `  用量 ${usage.inputTokens}↓ ${usage.outputTokens}↑${usage.credits === undefined ? '' : ` credits ${usage.credits}`}${budgetExceeded ? ' [超预算!]' : ''}`,
    `  产物校验 ${planOk ? 'OK' : 'FAIL'} · 证据 ${outFile}`,
    evidence.visibleError === null ? '' : `  错误: ${evidence.visibleError}`,
  ].join('\n'))}\n`);
  return passed ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(safeLine(`e2e 运行失败:${String(error)}`));
  process.exitCode = 1;
} finally {
  rmSync(workspace, {recursive: true, force: true});
}
