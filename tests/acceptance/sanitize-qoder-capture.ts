/**
 * 手工运行:把 tests/acceptance/qoder-capture.ts 的真实录制转换成仓库内脱敏 fixture。
 *   npx tsx tests/acceptance/sanitize-qoder-capture.ts --in .tmp/qoder-capture --out tests/fixtures/streams/qoder
 * 脱敏规则:资源 id(evt/agent/env/sess/sthr/request)换成稳定占位符;时间戳归一;密钥已由录制层剔除。
 * 模型目录与协议字段保持真实,fixture 才有回归价值。
 */
import {mkdirSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const inDir = arg('--in') ?? '.tmp/qoder-capture';
const outDir = arg('--out') ?? 'tests/fixtures/streams/qoder';
mkdirSync(outDir, {recursive: true});

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index !== -1 ? process.argv[index + 1] : undefined;
  return value;
}

const idMap = new Map<string, string>();
let eventCounter = 0;
let resourceCounter = 0;

function mapId(id: string): string {
  const known = idMap.get(id);
  if (known) return known;
  let mapped: string;
  if (id.startsWith('evt_')) mapped = `evt_${String(++eventCounter).padStart(4, '0')}`;
  else if (id.startsWith('sess_')) mapped = `sess_fixture_${++resourceCounter}`;
  else if (id.startsWith('agent_')) mapped = 'agent_fixture';
  else if (id.startsWith('env_')) mapped = 'env_fixture';
  else if (id.startsWith('sthr_')) mapped = 'sthr_fixture';
  else mapped = `id_fixture_${++resourceCounter}`;
  idMap.set(id, mapped);
  return mapped;
}

function sanitize(text: string): string {
  let out = text;
  // 真实资源 id 总含数字(agent_name 等字段名不能误伤)。
  out = out.replace(/\b(?:evt|sess|agent|env|sthr)_(?=[0-9a-z_]*[0-9])[0-9a-z_]+/g, match => mapId(match));
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'request-fixture');
  out = out.replace(/"processed_at":"[^"]*"/g, '"processed_at":"2026-11-01T00:00:00Z"');
  out = out.replace(/"at":\d+/g, '"at":0');
  return out;
}

function framesOf(file: string): Array<{method?: string; path?: string; status?: number; frame?: string; response?: unknown; request?: unknown; phase?: string; frames?: string[]}> {
  return readFileSync(join(inDir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as {method?: string; path?: string; status?: number; frame?: string; response?: unknown; request?: unknown; phase?: string; frames?: string[]});
}

function writeSse(name: string, frames: string[]): void {
  writeFileSync(join(outDir, name), `${frames.map(frame => `${sanitize(frame).trimEnd()}\n\n`).join('')}`);
  console.log(`✓ ${name} (${frames.length} frames)`);
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(outDir, name), `${sanitize(JSON.stringify(value, null, 2))}\n`);
  console.log(`✓ ${name}`);
}

const files = readdirSync(inDir);
if (files.length === 0) { console.error(`目录为空:${inDir}`); process.exit(1); }

// s1: 纯文本回合 + usage 尾部帧。
const s1 = framesOf('s1-text.jsonl');
const s1frames = s1.flatMap(entry => entry.frame ? [entry.frame] : []);
writeSse('text-turn.txt', s1frames);
const modelsResponse = s1.find(entry => entry.response && JSON.stringify(entry.response).includes('max_input_tokens'))?.response;
if (modelsResponse) writeJson('models.json', modelsResponse);

// s2: 第一条流 = custom_tool_use + requires_action;第二条流 = 新会话上的旧轮次重放。
const s2 = framesOf('s2-tool.jsonl');
const firstStream: string[] = [];
const secondStream: string[] = [];
let seenSessionsPosts = 0;
for (const entry of s2) {
  if (entry.method === 'POST' && entry.path?.endsWith('/sessions')) seenSessionsPosts += 1;
  if (!entry.frame) continue;
  (seenSessionsPosts <= 1 ? firstStream : secondStream).push(entry.frame);
}
writeSse('custom-tool-requires-action.txt', firstStream);
if (secondStream.length) writeSse('transcript-fallback-turn.txt', secondStream);

// s6: 内置工具 requires_action(真实 evaluated_permission 形状)。
const s6 = framesOf('s6-builtin.jsonl');
writeSse('builtin-tool-requires-action.txt', s6.flatMap(entry => entry.frame ? [entry.frame] : []));

// r1: busy 409 错误体。
const r1 = framesOf('r1-busy.jsonl');
const busy = r1.find(entry => entry.status === 409 && entry.response && typeof entry.response === 'object');
if (busy) writeJson('busy-409.json', busy.response);

// r2: agent version 冲突 409。
const r2 = framesOf('r2-agent-version.jsonl');
const conflict = r2.find(entry => entry.status === 409 && entry.response && typeof entry.response === 'object');
if (conflict) writeJson('agent-version-conflict-409.json', conflict.response);

// r3: 首次流 + 重连续传。
const r3 = framesOf('r3-reconnect.jsonl');
for (const entry of r3) {
  if (entry.phase === 'first-connection' && entry.frames) writeSse('reconnect-first.txt', entry.frames);
  if (entry.phase === 'reconnect' && entry.frames) writeSse('reconnect-resume.txt', entry.frames);
}

// s4: cancel 的 interrupt 请求与响应。
const s4 = framesOf('s4-cancel.jsonl');
const interruptReq = s4.find(entry => entry.method === 'POST' && typeof entry.request === 'object' && entry.request !== null && JSON.stringify(entry.request).includes('user.interrupt'));
if (interruptReq) writeJson('interrupt-exchange.json', {request: interruptReq.request, status: interruptReq.status});

console.log(`\n输出目录: ${outDir};映射 id 数: ${idMap.size}`);
