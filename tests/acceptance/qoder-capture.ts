/**
 * 手工运行:录制 Qoder Cloud Agents 的真实协议事件,供脱敏 fixture 使用。
 *   npx tsx tests/acceptance/qoder-capture.ts [--out /tmp/qoder-capture]
 * 凭据来自 ~/.bitori/.env(LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)。
 * 录制层在 fetch 边界 tee 原始 SSE 字节;Authorization 头与密钥值不落盘。
 */
import {config as loadDotenv} from 'dotenv';
import {mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import { homedir } from 'node:os';
import {QoderClient, resolveQoderModelId} from '../../src/providers/qoder.js';
import type {ProviderProfile} from '../../src/config/types.js';
import type {ChatRequest} from '../../src/providers/types.js';

loadDotenv({path: join(homedir(), '.bitori', '.env')});

const apiKey = process.env['LLM_API_KEY'];
const baseUrl = process.env['LLM_BASE_URL'];
const model = process.env['LLM_MODEL'];
if (!apiKey || !baseUrl || !model) {
  console.error('缺少 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL(~/.bitori/.env)');
  process.exit(1);
}
const requiredKey = apiKey;
const requiredBase = baseUrl;
const requiredModel = model;

const outDir = (() => {
  const index = process.argv.indexOf('--out');
  const arg = index !== -1 ? process.argv[index + 1] : undefined;
  return arg ?? '/tmp/qoder-capture';
})();
const only = (() => {
  const index = process.argv.indexOf('--only');
  const arg = index !== -1 ? process.argv[index + 1] : undefined;
  return arg ? arg.split(',') : [];
})();
mkdirSync(outDir, {recursive: true});

const profile: ProviderProfile = {
  name: 'capture', protocol: 'qoder', model: requiredModel, baseUrl: requiredBase, apiKey: requiredKey, thinking: {type: 'disabled'},
};

interface RecordedCall {
  t: number;
  method: string;
  path: string;
  status?: number;
  request?: unknown;
  response?: unknown;
  sse?: boolean;
}

function logPath(name: string): string { return join(outDir, `${name}.jsonl`); }

function record(name: string, entry: RecordedCall | Record<string, unknown>): void {
  appendFileSync(logPath(name), `${JSON.stringify({...entry, at: Date.now()})}\n`);
}

function stripSecret(text: string): string {
  return text.replaceAll(requiredKey, '<REDACTED_KEY>');
}

function makeRecorder(name: string): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    const request = typeof init?.body === 'string' ? safeJson(stripSecret(init.body)) : undefined;
    const wantsStream = (init?.headers as Record<string, string> | undefined)?.['Accept'] === 'text/event-stream';
    const response = await fetch(href, init);
    record(name, {
      t: 0, method, path: url.pathname + url.search, status: response.status,
      request, ...(wantsStream ? {sse: true} : {}),
    });
    if (!wantsStream) {
      const text = await response.text();
      record(name, {t: 0, response: safeJson(stripSecret(text))});
      return new Response(text, {status: response.status, statusText: response.statusText, headers: response.headers});
    }
    // tee 原始 SSE:按帧(空行分隔)记录未改写的字节。
    const source = response.body!;
    const [forProvider, forRecord] = source.tee();
    void (async () => {
      const reader: ReadableStreamDefaultReader<Uint8Array> = forRecord.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});
          let index = buffer.indexOf('\n\n');
          while (index !== -1) {
            record(name, {frame: stripSecret(buffer.slice(0, index))});
            buffer = buffer.slice(index + 2);
            index = buffer.indexOf('\n\n');
          }
        }
        if (buffer.trim()) record(name, {frame: stripSecret(buffer)});
      } catch { /* 录制失败不影响主流程 */ }
    })();
    return new Response(forProvider, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text.slice(0, 2000); }
}

async function collect(client: QoderClient, request: ChatRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  const tools: string[] = [];
  for await (const event of client.streamChat(request, signal)) {
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'tool_call_start') tools.push(event.name);
    if (event.type === 'error') text += `\n[provider error ${event.error.code}/${event.error.statusCode ?? ''}] ${event.error.message}`;
  }
  return `${text}${tools.length ? `\n[tool calls] ${tools.join(', ')}` : ''}`;
}

const echoTool = {
  name: 'capture_echo',
  description: 'Echo the given text back. Call this tool when asked.',
  inputSchema: {type: 'object' as const, properties: {text: {type: 'string'}}, required: ['text']},
};

function toolResultItems(callId: string, providerCallId: string, userText: string, result: Record<string, unknown>): NonNullable<ChatRequest['items']> {
  return [
    {type: 'message', messageId: 'cap-u1', role: 'user', content: userText},
    {type: 'assistant_iteration', messageId: 'cap-a1', content: '', toolCalls: [
      {callId, providerCallId, name: 'capture_echo', argumentsText: JSON.stringify({text: 'hello'}), arguments: {text: 'hello'}},
    ]},
    {type: 'tool_results', assistantMessageId: 'cap-a1', results: [
      {callId, providerCallId, name: 'capture_echo', result: {status: 'success', output: result}},
    ]},
  ];
}

class QoderHttpErrorLite extends Error {
  constructor(public readonly status: number, message: string) { super(`HTTP ${status}: ${message}`); }
}

async function scenario(name: string, run: () => Promise<string>): Promise<void> {
  if (only.length > 0 && !only.includes(name)) { console.log(`– ${name} (skipped)`); return; }
  const file = logPath(name);
  if (existsSync(file)) writeFileSync(file, '');
  const started = Date.now();
  try {
    const outcome = await run();
    record(name, {summary: outcome});
    console.log(`✓ ${name} (${Date.now() - started}ms) → ${outcome.slice(0, 160).replace(/\n/g, ' ')}`);
  } catch (error) {
    record(name, {summary_error: String(error).slice(0, 500)});
    console.log(`✗ ${name}: ${String(error).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const root = profile.baseUrl.replace(/\/+$/, '') + '/api/v1/cloud';
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {Authorization: `Bearer ${requiredKey}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    record('raw', {t: 0, method, path, status: response.status, request: body});
    const text = await response.text();
    record('raw', {t: 0, response: safeJson(stripSecret(text)), status: response.status});
    if (!response.ok) throw new QoderHttpErrorLite(response.status, text.slice(0, 400));
    return safeJson(text);
  };
  const resolveModel = async (): Promise<string> => {
    const payload = await call('GET', '/models') as {data?: Array<{id?: string; display_name?: string; is_enabled?: boolean}>};
    return resolveQoderModelId(requiredModel, payload.data ?? []);
  };
  const ensureEnvironment = async (): Promise<string> => {
    const listed = await call('GET', '/environments?limit=50') as {data?: Array<{id?: string; name?: string; config?: {type?: string}; archived_at?: string | null}>};
    const existing = listed.data?.find(row => row.name === 'bitori' && row.archived_at == null && row.config?.type === 'self_hosted');
    if (existing?.id) return existing.id;
    const created = await call('POST', '/environments', {name: 'bitori', description: 'Bitori local tool host', config: {type: 'self_hosted'}, metadata: {source: 'bitori'}}) as {id: string};
    return created.id;
  };

  // R1 真实 busy:同一会话在 turn 进行中途再发 user.message,期望 409。
  await scenario('r1-busy', async () => {
    const modelId = await resolveModel();
    const environmentId = await ensureEnvironment();
    const agents = await call('GET', '/agents?limit=50') as {data?: Array<{id?: string; name?: string; archived_at?: string | null}>};
    const agent = agents.data?.find(row => row.name === 'bitori' && row.archived_at == null);
    if (!agent?.id) throw new Error('no bitori agent');
    const session = await call('POST', '/sessions', {agent: agent.id, environment_id: environmentId, title: 'Bitori busy probe', metadata: {source: 'bitori'}}) as {id: string};
    await call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.message', content: [{type: 'text', text: '从 1 数到 30,每个数字单独一行。'}]}]});
    const response = await fetch(`${root}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${requiredKey}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({events: [{type: 'user.message', content: [{type: 'text', text: '第二问'}]}]}),
    });
    const text = await response.text();
    record('r1-busy', {t: 0, method: 'POST', path: `/sessions/${session.id}/events`, status: response.status, request: 'second user.message while processing'});
    record('r1-busy', {t: 0, response: safeJson(stripSecret(text)), status: response.status});
    await call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.interrupt'}]}).catch(() => undefined);
    void modelId;
    return `busy status=${response.status}`;
  });

  // R2 过期 agent version 更新 → 期望 409 冲突形状。
  await scenario('r2-agent-version', async () => {
    const agents = await call('GET', '/agents?limit=50') as {data?: Array<{id?: string; name?: string; version?: number}>};
    const agent = agents.data?.find(row => row.name === 'bitori');
    if (!agent?.id) throw new Error('no bitori agent');
    const response = await fetch(`${root}/agents/${agent.id}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${requiredKey}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({version: (agent.version ?? 1) - 7, model: await resolveModel(), system: 'stale version probe', tools: [{type: 'agent_toolset_20260401', enabled_tools: ['Bash'], configs: [{name: 'Bash', enabled: false}]}]}),
    });
    const text = await response.text();
    record('r2-agent-version', {t: 0, method: 'POST', path: `/agents/${agent.id}`, status: response.status, request: `version=${(agent.version ?? 1) - 7} while current=${agent.version}`});
    record('r2-agent-version', {t: 0, response: safeJson(stripSecret(text)), status: response.status});
    return `update-with-stale-version status=${response.status}`;
  });

  // R3 Last-Event-ID 重连:turn 中途切断流,带 Last-Event-ID 重连,观察重放/续传。
  await scenario('r3-reconnect', async () => {
    const modelId = await resolveModel();
    void modelId;
    const environmentId = await ensureEnvironment();
    const agents = await call('GET', '/agents?limit=50') as {data?: Array<{id?: string; name?: string; archived_at?: string | null}>};
    const agent = agents.data?.find(row => row.name === 'bitori' && row.archived_at == null);
    if (!agent?.id) throw new Error('no bitori agent');
    const session = await call('POST', '/sessions', {agent: agent.id, environment_id: environmentId, title: 'Bitori reconnect probe', metadata: {source: 'bitori'}}) as {id: string};
    await call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.message', content: [{type: 'text', text: '从 1 数到 30,每个数字单独一行。'}]}]});
    const open = async (lastEventId?: string) => await fetch(`${root}/sessions/${session.id}/events/stream?event_deltas[]=agent.message`, {
      headers: {Authorization: `Bearer ${requiredKey}`, Accept: 'text/event-stream', ...(lastEventId ? {'Last-Event-ID': lastEventId} : {})},
    });
    const first = await open();
    const reader = first.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastId = '';
    const collectFrames = async (stopAfter: number): Promise<string[]> => {
      const frames: string[] = [];
      const startedAt = Date.now();
      while (frames.length < stopAfter && Date.now() - startedAt < 20_000) {
        const raced = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve('timeout'), 5_000))]);
        if (raced === 'timeout') break;
        const result = raced as {done?: boolean; value?: Uint8Array};
        if (result.done) break;
        buffer += decoder.decode(result.value, {stream: true});
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.trim()) frames.push(frame);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          if (id) lastId = id;
          index = buffer.indexOf('\n\n');
        }
      }
      return frames;
    };
    const phase1 = await collectFrames(4);
    record('r3-reconnect', {phase: 'first-connection', frames: phase1.map(frame => stripSecret(frame)), lastId});
    reader.cancel().catch(() => undefined);
    const second = await open(lastId);
    const secondReader = second.body!.getReader();
    buffer = '';
    let last2 = '';
    const frames2: string[] = [];
    const started2 = Date.now();
    while (Date.now() - started2 < 20_000) {
      const raced = await Promise.race([secondReader.read(), new Promise(resolve => setTimeout(() => resolve('timeout'), 8_000))]);
      if (raced === 'timeout') break;
      const result = raced as {done?: boolean; value?: Uint8Array};
      if (result.done) break;
      buffer += decoder.decode(result.value, {stream: true});
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.trim()) frames2.push(frame);
        const id = /^id: (.+)$/m.exec(frame)?.[1];
        if (id) last2 = id;
        index = buffer.indexOf('\n\n');
      }
    }
    record('r3-reconnect', {phase: 'reconnect', frames: frames2.map(frame => stripSecret(frame)), lastId: last2});
    secondReader.cancel().catch(() => undefined);
    await call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.interrupt'}]}).catch(() => undefined);
    return `phase1=${phase1.length} frames, reconnect=${frames2.length} frames, replay overlap detected=${frames2.some(frame => phase1.includes(frame))}`;
  });

  await scenario('s1-text', async () => {
    const client = new QoderClient(profile, makeRecorder('s1-text'));
    return await collect(client, {
      messages: [],
      system: [{text: 'You are a terse test agent. Reply with exactly two Chinese characters: 收到', cacheable: false}],
      items: [{type: 'message', messageId: 'cap-u1', role: 'user', content: '只回复:收到'}],
    }, new AbortController().signal);
  });

  // S2 自定义工具往返(custom_tool_use + requires_action + 结果回传后续读文本)。
  await scenario('s2-tool', async () => {
    const client = new QoderClient(profile, makeRecorder('s2-tool'));
    const request: ChatRequest = {
      messages: [],
      system: [{text: 'You are a terse test agent.', cacheable: false}],
      items: [{type: 'message', messageId: 'cap-u1', role: 'user', content: 'Call the capture_echo tool with text=hello, then tell me the result.'}],
      tools: [echoTool],
    };
    const first = await collect(client, request, new AbortController().signal);
    const toolStart = /evt_[0-9a-z]+/.exec(first);
    void toolStart;
    // 从 provider 内部 pending 无法直接取 id;第二次请求由 continuationResults 依据 providerCallId 匹配。
    // 这里通过记录文件找到 custom_tool_use id。
    const raw = readFileSyncSafe(logPath('s2-tool'));
    const idMatch = /"type":"agent\.custom_tool_use"[^\n]*?"id":"(evt_[^"]+)"/.exec(raw)
      ?? /"id":"(evt_[^"]+)"[^\n]*?"type":"agent\.custom_tool_use"/.exec(raw);
    const callId = idMatch?.[1] ?? 'evt_unknown';
    const second = await collect(client, {...request, items: toolResultItems('cap-c1', callId, 'Call the capture_echo tool with text=hello, then tell me the result.', {echo: 'hello'})}, new AbortController().signal);
    return `first=[${first}] second=[${second}]`;
  });

  // S3 busy:第一轮流尚未结束时向同一会话再发消息,期望收到 409 busy 语义。
  await scenario('s3-busy', async () => {
    const recorder = makeRecorder('s3-busy');
    const client = new QoderClient(profile, recorder);
    const request: ChatRequest = {
      messages: [],
      items: [{type: 'message', messageId: 'cap-u1', role: 'user', content: '数到 20,每个数字一行,不要停顿。'}],
    };
    // 复用同一 client(同 conversationKey),第一次流在后台推进,立刻发第二次。
    const firstRun = collect(client, request, new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 400));
    const second = await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'cap-u1', role: 'user', content: '数到 20,每个数字一行,不要停顿。'},
        {type: 'message', messageId: 'cap-u2', role: 'user', content: '第二问:只回答 OK'},
      ],
    }, new AbortController().signal);
    const firstOut = await firstRun;
    return `first=[${firstOut.slice(0, 80)}] second=[${second.slice(0, 200)}]`;
  });

  // S4 取消:流中途 abort,捕获 user.interrupt 与后续流关闭。
  await scenario('s4-cancel', async () => {
    const client = new QoderClient(profile, makeRecorder('s4-cancel'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    const text = await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'cap-u1', role: 'user', content: '写一篇 300 字的散文,慢慢写。'}],
    }, controller.signal);
    return text;
  });

  // S5 重连:取消后立刻用同一 client 再发起(带 Last-Event-ID 的新流),验证重放语义。
  await scenario('s5-reconnect', async () => {
    const client = new QoderClient(profile, makeRecorder('s5-reconnect'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    await collect(client, {
      messages: [],
      items: [{type: 'message', messageId: 'cap-u1', role: 'user', content: '从 1 数到 40,每行一个。'}],
    }, controller.signal).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 800));
    return await collect(client, {
      messages: [],
      items: [
        {type: 'message', messageId: 'cap-u1', role: 'user', content: '从 1 数到 40,每行一个。'},
        {type: 'message', messageId: 'cap-u2', role: 'user', content: '只回答:完成'},
      ],
    }, new AbortController().signal);
  });

  // S6 内置工具实验:直接按协议创建启用 Bash 的 agent,观察服务端内置工具在 self_hosted 环境的真实行为
  // (requires_action / 拒绝 / 忽略),这是 QoderClient 正常路径刻意避开的分支。
  await scenario('s6-builtin', async () => {
    const recorder = makeRecorder('s6-builtin');
    void recorder;
    const root = profile.baseUrl.replace(/\/+$/, '') + '/api/v1/cloud';
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${root}${path}`, {
        method,
        headers: {Authorization: `Bearer ${requiredKey}`, 'Content-Type': 'application/json', Accept: 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      record('s6-builtin', {t: 0, method, path, status: response.status, request: body});
      const text = await response.text();
      record('s6-builtin', {t: 0, response: safeJson(stripSecret(text))});
      return safeJson(text);
    };
    const listed = await call('GET', '/environments?limit=50') as {data?: Array<{id?: string; name?: string; config?: {type?: string}}>};
    let environmentId = listed.data?.find(row => row.name === 'bitori' && row.config?.type === 'self_hosted')?.id;
    if (!environmentId) {
      const created = await call('POST', '/environments', {name: 'bitori', description: 'Bitori local tool host', config: {type: 'self_hosted'}, metadata: {source: 'bitori'}}) as {id?: string};
      environmentId = created.id;
    }
    const agentBody = {
      name: 'bitori-builtin-probe',
      model: await resolveModel(),
      system: 'You are a terse test agent. Use your built-in Bash tool to run `pwd`, then say DONE.',
      description: 'Bitori builtin tool probe',
      metadata: {source: 'bitori'},
      tools: [{type: 'agent_toolset_20260401', enabled_tools: ['Bash'], configs: [{name: 'Bash', enabled: true}]}],
    };
    const agents = await call('GET', '/agents?limit=50') as {data?: Array<{id?: string; name?: string}>};
    let agent = agents.data?.find(row => row.name === 'bitori-builtin-probe');
    if (!agent) agent = await call('POST', '/agents', agentBody) as {id?: string; version?: number};
    else agent = await call('POST', `/agents/${agent.id}`, {version: (agent as {version?: number}).version ?? 1, ...agentBody}) as {id?: string};
    const session = await call('POST', '/sessions', {agent: agent.id, environment_id: environmentId, title: 'Bitori builtin probe', metadata: {source: 'bitori'}}) as {id?: string};
    if (!session.id) throw new Error('no session');
    await call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.message', content: [{type: 'text', text: '用你的内置 Bash 运行 pwd,然后只回答 DONE'}]}]});
    // 收集 20 秒 SSE 原始帧。
    const streamUrl = `${root}/sessions/${session.id}/events/stream?event_deltas[]=agent.message`;
    const response = await fetch(streamUrl, {headers: {Authorization: `Bearer ${requiredKey}`, Accept: 'text/event-stream'}});
    record('s6-builtin', {t: 0, method: 'GET', path: new URL(response.url).pathname, status: response.status, sse: true});
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20_000;
    let buffer = '';
    let frames = '';
    while (Date.now() < deadline) {
      const raced = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve('timeout'), Math.max(50, deadline - Date.now())))]);
      if (raced === 'timeout') break;
      const result = raced as {done?: boolean; value?: Uint8Array};
      if (result.done) break;
      buffer += decoder.decode(result.value, {stream: true});
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        frames += frame;
        record('s6-builtin', {frame: stripSecret(frame)});
        index = buffer.indexOf('\n\n');
      }
    }
    reader.cancel().catch(() => undefined);
    void call('POST', `/sessions/${session.id}/events`, {events: [{type: 'user.interrupt'}]});
    const sawTool = /agent\.tool_use|requires_action/.test(frames);
    return `frames captured, builtin tool activity=${sawTool}`;
  });

  console.log(`\n录制完成 → ${outDir}`);
};

function readFileSyncSafe(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

await main();
