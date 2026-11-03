import type {ProviderProfile} from '../config/types.js';
import type {JsonObject, ToolDefinition, ToolExecutionResult} from '../tools/types.js';
import type {ProviderErrorCode} from './errors.js';
import {isAbortError, normalizeProviderError} from './errors.js';
import type {ChatRequest, FinishReason, LLMClient, ModelContextItem, StreamEvent} from './types.js';

const AGENT_NAME = 'bitori';
const ENVIRONMENT_NAME = 'bitori';
const SOURCE = 'bitori';
/** Qoder 内置工具名与 mcp__ 前缀不能用作 custom tool 名。 */
const RESERVED_TOOL_NAMES = new Set([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'webfetch', 'websearch', 'advisor', 'task',
]);

export class QoderHttpError extends Error {
  readonly status: number;
  readonly providerCode?: ProviderErrorCode;
  constructor(status: number, message: string, providerCode?: ProviderErrorCode) {
    super(message);
    this.name = 'QoderHttpError';
    this.status = status;
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
}

/** 把用户填写的网关根路径归一成 Cloud Agents `/api/v1/cloud`。 */
export function cloudApiRoot(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/api/v1/cloud')) return url;
  if (url.endsWith('/api/v1')) return `${url}/cloud`;
  return `${url}/api/v1/cloud`;
}

export function resolveQoderModelId(
  configured: string,
  models: Array<{id?: unknown; display_name?: unknown; is_enabled?: unknown}>,
): string {
  const wanted = configured.trim();
  if (!wanted) return wanted;
  const enabled = models.filter(model => model.is_enabled !== false);
  const exact = enabled.find(model => model.id === wanted);
  if (typeof exact?.id === 'string') return exact.id;
  const folded = foldModelName(wanted);
  const byName = enabled.find(model => typeof model.display_name === 'string' && foldModelName(model.display_name) === folded);
  if (typeof byName?.id === 'string') return byName.id;
  const byIdFold = enabled.find(model => typeof model.id === 'string' && foldModelName(model.id) === folded);
  if (typeof byIdFold?.id === 'string') return byIdFold.id;
  return wanted;
}

function foldModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, '');
}

interface SessionState {
  sessionId: string;
  pending: Map<string, string>;
  lastEventId?: string;
  sentUserMessageIds: Set<string>;
  fingerprint: string;
  /** 同一 tool_use 事件可能随重连重放;真实流中多个帧共用事件 id,所以只去重工具调用。 */
  seenToolUseIds: Set<string>;
}

interface QoderCustomTool {
  type: 'custom';
  name: string;
  description: string;
  input_schema: JsonObject;
}

interface QoderBuiltinToolset {
  type: 'agent_toolset_20260401';
  enabled_tools: string[];
  configs: Array<{name: string; enabled: boolean}>;
}

type QoderAgentTool = QoderCustomTool | QoderBuiltinToolset;

/**
 * 非空白名单会隐藏列表外的内置工具；Bash 再显式禁用，避免服务端工具在 requires_action 处挂起。
 * 本地能力通过 custom tools 提供。
 */
const BUILTIN_TOOLSET: QoderBuiltinToolset = {
  type: 'agent_toolset_20260401',
  enabled_tools: ['Bash'],
  configs: [{name: 'Bash', enabled: false}],
};

/**
 * 官方 Qoder Cloud Agents（PAT / SAT）协议。
 * 在账号下复用名为 bitori 的 self_hosted Environment 与 Agent，用 client-side custom tools 把工具交回本地执行。
 */
export class QoderClient implements LLMClient {
  readonly #profile: ProviderProfile;
  readonly #fetch: typeof fetch;
  readonly #root: string;
  #modelId: string | undefined;
  #environmentId: string | undefined;
  #agent: {id: string; version: number; fingerprint: string} | undefined;
  readonly #sessions = new Map<string, SessionState>();

  public constructor(profile: ProviderProfile, fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.#profile = profile;
    this.#fetch = fetchImpl;
    this.#root = cloudApiRoot(profile.baseUrl);
  }

  public async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    try {
      yield* this.#run(request, signal);
    } catch (error) {
      if (isAbortError(error, signal)) yield {type: 'completed', finishReason: 'cancelled'};
      else yield {type: 'error', error: normalizeProviderError(error, this.#profile)};
    }
  }

  async *#run(request: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const key = conversationKey(request);
    const items = request.items ?? [];
    const tools = request.tools ?? [];
    const mapping = mapTools(tools);
    const system = request.system?.map(block => block.text).join('\n\n') ?? '';
    const modelId = await this.#resolveModel(signal);
    const agentTools: QoderAgentTool[] = [...mapping.custom, BUILTIN_TOOLSET];
    const fingerprint = agentFingerprint(modelId, system, agentTools);
    const continuation = continuationResults(items, this.#sessions.get(key));

    if (continuation) {
      const session = this.#sessions.get(key)!;
      await this.#postEvents(session.sessionId, continuation.events, signal);
      for (const event of continuation.events) session.pending.delete(event.custom_tool_use_id);
      yield* this.#consumeTurn(session, mapping.byCustom, signal);
      return;
    }

    await this.#ensureAgent(modelId, system, agentTools, fingerprint, signal);
    const environmentId = await this.#ensureEnvironment(signal);
    const existing = this.#sessions.get(key);
    if (existing && existing.fingerprint === fingerprint) {
      const events = newUserEvents(items, existing);
      if (events.length > 0) {
        let accepted = false;
        try {
          await this.#postEvents(existing.sessionId, events, signal);
          accepted = true;
        } catch (error) {
          if (!isSessionBusy(error)) throw error;
          // 上一轮仍占用旧会话：先尽力中断，再换新会话发送完整转录。
          await this.#interrupt(existing.sessionId);
        }
        if (accepted) {
          const turn = this.#consumeTurn(existing, mapping.byCustom, signal)[Symbol.asyncIterator]();
          let emitted = false;
          try {
            while (true) {
              const next = await turn.next();
              if (next.done) return;
              emitted = true;
              yield next.value;
            }
          } catch (error) {
            // 若服务端在流开头就报 busy，尚未向调用方发出任何内容，可以安全换会话重试。
            if (emitted || !isSessionBusy(error)) throw error;
            await this.#interrupt(existing.sessionId);
          }
        }
      }
    }

    const session = await this.#createSession(environmentId, fingerprint, signal);
    this.#sessions.set(key, session);
    const transcript = shouldSendTranscript(items);
    const text = transcript ? renderTranscript(items) : latestUserText(request);
    if (!text.trim()) throw new QoderHttpError(400, 'Qoder 会话没有可发送的用户消息');
    const events = [{type: 'user.message', content: [{type: 'text', text}]}];
    for (const reminder of items.filter(item => item.type === 'reminder')) {
      events.push({type: 'user.message', content: [{type: 'text', text: reminder.text}]});
    }
    markSentUsers(session, items);
    await this.#postEvents(session.sessionId, events, signal);
    yield* this.#consumeTurn(session, mapping.byCustom, signal);
  }

  async *#consumeTurn(
    session: SessionState,
    byCustom: Map<string, string>,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const turnAbort = new AbortController();
    const onAbort = () => turnAbort.abort();
    signal.addEventListener('abort', onAbort, {once: true});
    let finish: FinishReason | undefined;
    let sawActivity = false;
    let timedOut = false;
    // 新建 SSE 连接时服务端会先重放上一轮的 idle 快照；不能据此判本轮结束。
    const watchdog = setTimeout(() => { timedOut = true; turnAbort.abort(); }, 300_000);
    const streamed = new Set<string>();
    const started = new Map<string, number>();
    let reconnectsLeft = 3;
    try {
      const streamPath = (sessionId: string): string => {
        const query = new URLSearchParams();
        query.append('event_deltas[]', 'agent.message');
        return `/sessions/${sessionId}/events/stream?${query.toString()}`;
      };
      outer: while (true) {
        let streamEndedCleanly = false;
        try {
          const headers: Record<string, string> = {Accept: 'text/event-stream'};
          if (session.lastEventId) headers['Last-Event-ID'] = session.lastEventId;
          const response = await this.#raw('GET', streamPath(session.sessionId), {headers, signal: turnAbort.signal});
          for await (const frame of readSse(response)) {
            if (frame.id) session.lastEventId = frame.id;
            const data = frame.data;
            const type = typeof data.type === 'string' ? data.type : frame.event;
            if (type === 'session.status_running' || type === 'session.thread_status_running' || type === 'agent.thinking' || type === 'agent.tool_use' || type === 'agent.tool_result') {
              sawActivity = true;
              continue;
            }
            if (type === 'event_delta') {
              const eventId = stringField(data, 'event_id') ?? frame.id;
              const text = deltaText(data.delta);
              if (eventId && text) {
                sawActivity = true;
                streamed.add(eventId);
                yield {type: 'text_delta', text};
              }
              continue;
            }
            if (type === 'agent.message') {
              const id = stringField(data, 'id') ?? frame.id;
              if (id && streamed.has(id)) continue;
              const text = contentText(data.content);
              if (text) {
                sawActivity = true;
                yield {type: 'text_delta', text};
              }
              continue;
            }
            if (type === 'agent.custom_tool_use') {
              const id = stringField(data, 'id');
              const customName = stringField(data, 'name') ?? '';
              if (!id || session.seenToolUseIds.has(id)) continue;
              session.seenToolUseIds.add(id);
              sawActivity = true;
              const name = byCustom.get(customName) ?? customName;
              const position = started.size;
              started.set(id, position);
              session.pending.set(id, name);
              const argumentsText = JSON.stringify(data.input ?? {});
              yield {type: 'tool_call_start', internalId: id, providerCallId: id, position, name};
              if (argumentsText) yield {type: 'tool_call_arguments_delta', internalId: id, delta: argumentsText};
              yield {type: 'tool_call_end', internalId: id};
              continue;
            }
            if (type === 'span.model_request_end') {
              // Qoder 只上报 credits(span.model_usage.credits),不上报 tokens;真实形状见 fixtures。
              const credits = creditsFromSpan(data);
              if (credits !== undefined) {
                sawActivity = true;
                yield {type: 'usage', usage: {inputTokens: 0, outputTokens: 0, credits}};
              }
              continue;
            }
            if (type === 'session.usage' || type === 'span.model_request_start') continue;
            if (type === 'session.thread_status_idle' || type === 'session.status_idle') {
              const reason = stopReasonType(data);
              // 只有仍有未回传的自定义工具时才结束本轮；requires_action 快照可能来自上一轮。
              const pendingAction = session.pending.size > 0;
              if (!sawActivity && !pendingAction) continue;
              if (pendingAction) finish = 'tool_calls';
              else if (reason === 'requires_action') {
                throw new QoderHttpError(502, `Qoder 要求处理客户端无法承接的动作(stop_reason=requires_action, event_ids=${JSON.stringify(stopReasonEventIds(data) ?? [])})`, 'unsupported_action');
              } else if (reason === 'end_turn' || type === 'session.status_idle' || reason === undefined) finish = 'stop';
              if (finish) { turnAbort.abort(); break; }
            }
            if (type === 'session.error' || type === 'session.status_terminated') {
              const message = stringField(data, 'message') ?? contentText(data.content) ?? 'Qoder 会话失败';
              throw new QoderHttpError(type === 'session.status_terminated' ? 499 : 502, message);
            }
          }
          streamEndedCleanly = true;
        } catch (error) {
          if (finish !== undefined && isAbortError(error, turnAbort.signal)) break outer; /* 本轮已结束，主动断开 SSE。 */
          if (timedOut) {
            if (!sawActivity) throw new QoderHttpError(504, 'Qoder 在 5 分钟内没有返回任何内容', 'network');
            finish = session.pending.size > 0 ? 'tool_calls' : 'stop';
            break outer;
          }
          if (isAbortError(error, signal)) {
            // 用户取消:清掉未完成的 custom tool 挂起项,否则 continuation 会向已中断的会话回传过期结果。
            session.pending.clear();
            await this.#interrupt(session.sessionId);
            throw error;
          }
          if (error instanceof QoderHttpError || reconnectsLeft <= 0) throw error;
          reconnectsLeft -= 1;
          await wait(500, turnAbort.signal);
          continue;
        }
        if (finish !== undefined) break;
        if (streamEndedCleanly && reconnectsLeft <= 0) break;
        if (streamEndedCleanly) {
          // 服务端在没有 idle/error 结论前关闭了流:带 Last-Event-ID 续读,而不是当成结束留下空回复。
          reconnectsLeft -= 1;
          await wait(500, turnAbort.signal);
          continue;
        }
      }
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
    }
    if (finish === undefined) finish = session.pending.size > 0 ? 'tool_calls' : 'stop';
    if (finish === 'stop') session.pending.clear();
    yield {type: 'completed', finishReason: finish};
  }

  async #resolveModel(signal: AbortSignal): Promise<string> {
    if (this.#modelId) return this.#modelId;
    const payload = await this.#json('GET', '/models', {signal});
    const models = Array.isArray(payload.data) ? payload.data as Array<{id?: unknown; display_name?: unknown; is_enabled?: unknown}> : [];
    this.#modelId = resolveQoderModelId(this.#profile.model, models);
    return this.#modelId;
  }

  async #ensureEnvironment(signal: AbortSignal): Promise<string> {
    if (this.#environmentId) return this.#environmentId;
    const listed = await this.#json('GET', '/environments?limit=50', {signal});
    const rows = Array.isArray(listed.data) ? listed.data as Array<Record<string, unknown>> : [];
    const existing = rows.find(row => row.name === ENVIRONMENT_NAME && row.archived_at == null && isSelfHosted(row));
    if (typeof existing?.id === 'string') { this.#environmentId = existing.id; return existing.id; }
    const created = await this.#json('POST', '/environments', {
      signal,
      body: {name: ENVIRONMENT_NAME, description: 'Bitori local tool host', config: {type: 'self_hosted'}, metadata: {source: SOURCE}},
    });
    if (typeof created.id !== 'string') throw new QoderHttpError(502, 'Qoder 未返回 environment id');
    this.#environmentId = created.id;
    return created.id;
  }

  async #ensureAgent(
    modelId: string,
    system: string,
    tools: QoderAgentTool[],
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#agent?.fingerprint === fingerprint) return;
    if (!this.#agent) {
      const listed = await this.#json('GET', '/agents?limit=50', {signal});
      const rows = Array.isArray(listed.data) ? listed.data as Array<Record<string, unknown>> : [];
      const existing = rows.find(row => row.name === AGENT_NAME && row.archived_at == null);
      if (typeof existing?.id === 'string') {
        this.#agent = {id: existing.id, version: numberField(existing, 'version') ?? 1, fingerprint: ''};
      }
    }
    if (!this.#agent) {
      const created = await this.#json('POST', '/agents', {
        signal,
        body: {name: AGENT_NAME, model: modelId, system, description: 'Bitori Cloud Agents adapter', metadata: {source: SOURCE}, tools},
      });
      if (typeof created.id !== 'string') throw new QoderHttpError(502, 'Qoder 未返回 agent id');
      this.#agent = {id: created.id, version: numberField(created, 'version') ?? 1, fingerprint};
      return;
    }
    const definition = {model: modelId, system, tools};
    try {
      const updated = await this.#json('POST', `/agents/${this.#agent.id}`, {
        signal,
        body: {version: this.#agent.version, ...definition},
      });
      this.#agent = {id: this.#agent.id, version: numberField(updated, 'version') ?? this.#agent.version + 1, fingerprint};
    } catch (error) {
      if (!(error instanceof QoderHttpError) || error.status !== 409) throw error;
      // 真实录制(agent-version-conflict-409.json):服务端乐观锁冲突会给出当前 version;重取后只重试一次。
      const freshVersion = await this.#fetchAgentVersion(this.#agent.id, signal);
      const updated = await this.#json('POST', `/agents/${this.#agent.id}`, {signal, body: {version: freshVersion, ...definition}});
      this.#agent = {id: this.#agent.id, version: numberField(updated, 'version') ?? freshVersion + 1, fingerprint};
    }
  }

  async #fetchAgentVersion(agentId: string, signal: AbortSignal): Promise<number> {
    const listed = await this.#json('GET', '/agents?limit=50', {signal});
    const rows = Array.isArray(listed.data) ? listed.data as Array<Record<string, unknown>> : [];
    const row = rows.find(item => item.id === agentId);
    const version = row === undefined ? undefined : numberField(row, 'version');
    if (version === undefined) throw new QoderHttpError(409, 'Qoder agent 版本无法重新获取，更新中止', 'provider_error');
    return version;
  }

  async #createSession(environmentId: string, fingerprint: string, signal: AbortSignal): Promise<SessionState> {
    if (!this.#agent) throw new QoderHttpError(500, 'Qoder Agent 尚未准备好');
    const created = await this.#json('POST', '/sessions', {
      signal,
      body: {agent: this.#agent.id, environment_id: environmentId, title: 'Bitori', metadata: {source: SOURCE}},
    });
    if (typeof created.id !== 'string') throw new QoderHttpError(502, 'Qoder 未返回 session id');
    return {sessionId: created.id, pending: new Map(), sentUserMessageIds: new Set(), seenToolUseIds: new Set(), fingerprint};
  }

  async #postEvents(sessionId: string, events: unknown[], signal: AbortSignal): Promise<void> {
    await this.#json('POST', `/sessions/${sessionId}/events`, {signal, body: {events}});
  }

  async #interrupt(sessionId: string): Promise<void> {
    try {
      await this.#json('POST', `/sessions/${sessionId}/events`, {body: {events: [{type: 'user.interrupt'}]}});
    } catch { /* 用户已取消，中断通知失败不覆盖取消。 */ }
  }

  async #json(method: string, path: string, options: {body?: unknown; signal?: AbortSignal} = {}): Promise<Record<string, unknown>> {
    const response = await this.#raw(method, path, {
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
      ...(options.signal ? {signal: options.signal} : {}),
    });
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { throw new QoderHttpError(response.status, text.slice(0, 300) || `Qoder HTTP ${response.status}`); }
  }

  async #raw(method: string, path: string, init: {headers?: Record<string, string>; body?: string; signal?: AbortSignal}): Promise<Response> {
    const response = await this.#fetch(`${this.#root}${path}`, {
      method,
      headers: {Authorization: `Bearer ${this.#profile.apiKey}`, ...init.headers},
      ...(init.body === undefined ? {} : {body: init.body}),
      ...(init.signal ? {signal: init.signal} : {}),
    });
    if (response.ok) return response;
    const text = await response.text();
    let payload: Record<string, unknown>;
    try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; }
    catch { throw new QoderHttpError(response.status, text.slice(0, 300) || `Qoder HTTP ${response.status}`); }
    throw new QoderHttpError(response.status, qoderErrorMessage(payload, response.status));
  }
}

function conversationKey(request: ChatRequest): string {
  for (const item of request.items ?? []) {
    if (item.type === 'message' && item.role === 'user') return item.messageId;
  }
  return 'default';
}

function latestUserText(request: ChatRequest): string {
  const items = request.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.type === 'message' && item.role === 'user') return item.content;
  }
  const last = request.messages.at(-1);
  return last?.content ?? '';
}

function shouldSendTranscript(items: ModelContextItem[]): boolean {
  let messages = 0;
  for (const item of items) {
    if (item.type === 'assistant_iteration' || item.type === 'tool_results') return true;
    if (item.type === 'message') messages += 1;
  }
  return messages > 1;
}

function isSessionBusy(error: unknown): boolean {
  if (error instanceof Error && /currently processing a turn/i.test(error.message)) return true;
  return error instanceof QoderHttpError && (error.status === 409 || error.status === 423);
}

function renderTranscript(items: ModelContextItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === 'message') lines.push(`${item.role}: ${item.content}`);
    else if (item.type === 'assistant_iteration') {
      if (item.content) lines.push(`assistant: ${item.content}`);
      for (const call of item.toolCalls) lines.push(`tool_call ${call.name}: ${call.argumentsText}`);
    } else if (item.type === 'tool_results') {
      for (const entry of item.results) lines.push(`tool_result ${entry.name}: ${JSON.stringify(entry.result)}`);
    }
  }
  return lines.join('\n');
}

function markSentUsers(session: SessionState, items: ModelContextItem[]): void {
  for (const item of items) {
    if (item.type === 'message' && item.role === 'user') session.sentUserMessageIds.add(item.messageId);
  }
}

function newUserEvents(items: ModelContextItem[], session: SessionState): Array<{type: string; content: Array<{type: string; text: string}>}> {
  const events: Array<{type: string; content: Array<{type: string; text: string}>}> = [];
  for (const item of items) {
    if (item.type === 'message' && item.role === 'user' && !session.sentUserMessageIds.has(item.messageId)) {
      events.push({type: 'user.message', content: [{type: 'text', text: item.content}]});
      session.sentUserMessageIds.add(item.messageId);
    }
  }
  if (events.length) {
    for (const item of items) {
      if (item.type === 'reminder') events.push({type: 'user.message', content: [{type: 'text', text: item.text}]});
    }
  }
  return events;
}

function continuationResults(
  items: ModelContextItem[],
  session: SessionState | undefined,
): {events: Array<{type: string; custom_tool_use_id: string; content: Array<{type: string; text: string}>}>} | undefined {
  if (!session || session.pending.size === 0) return undefined;
  const block = [...items].reverse().find(item => item.type === 'tool_results');
  if (!block || block.type !== 'tool_results') return undefined;
  const events = [];
  for (const entry of block.results) {
    const id = entry.providerCallId ?? entry.callId;
    if (!session.pending.has(id)) continue;
    events.push({
      type: 'user.custom_tool_result',
      custom_tool_use_id: id,
      content: [{type: 'text', text: formatToolResult(entry.result)}],
    });
  }
  return events.length ? {events} : undefined;
}

function formatToolResult(result: ToolExecutionResult): string {
  return JSON.stringify(result);
}

function mapTools(tools: ToolDefinition[]): {custom: QoderCustomTool[]; byCustom: Map<string, string>} {
  const byCustom = new Map<string, string>();
  const custom = tools.map(tool => {
    const name = customToolName(tool.name);
    byCustom.set(name, tool.name);
    const schema = isObjectSchema(tool.inputSchema) ? tool.inputSchema : {type: 'object', properties: {}};
    return {type: 'custom' as const, name, description: tool.description, input_schema: schema};
  });
  return {custom, byCustom};
}

function customToolName(name: string): string {
  const folded = name.toLowerCase();
  if (folded.startsWith('mcp__') || RESERVED_TOOL_NAMES.has(folded)) return `bitori__${name}`;
  return name;
}

function isObjectSchema(schema: JsonObject): boolean {
  return schema.type === 'object' || schema.type === undefined;
}

function agentFingerprint(modelId: string, system: string, tools: QoderAgentTool[]): string {
  return JSON.stringify({modelId, system, tools});
}

function isSelfHosted(row: Record<string, unknown>): boolean {
  const config = row.config;
  return typeof config === 'object' && config !== null && (config as {type?: unknown}).type === 'self_hosted';
}

function qoderErrorMessage(payload: Record<string, unknown>, status: number): string {
  const error = payload.error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return `Qoder HTTP ${status}`;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

function textBlock(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string') return value.text;
  return '';
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(block => textBlock(block)).join('');
  return textBlock(content);
}

function deltaText(delta: unknown): string {
  if (typeof delta !== 'object' || delta === null) return '';
  const record = delta as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  return contentText(record.content);
}

function stopReasonType(data: Record<string, unknown>): string | undefined {
  const reason = data.stop_reason;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && reason !== null && 'type' in reason && typeof reason.type === 'string') return reason.type;
  return undefined;
}

function stopReasonEventIds(data: Record<string, unknown>): string[] | undefined {
  const reason = data.stop_reason;
  if (typeof reason === 'object' && reason !== null && 'event_ids' in reason && Array.isArray(reason.event_ids)) {
    return reason.event_ids.filter((id): id is string => typeof id === 'string');
  }
  return undefined;
}

function creditsFromSpan(data: Record<string, unknown>): number | undefined {
  const modelUsage = data.model_usage;
  if (typeof modelUsage === 'object' && modelUsage !== null && 'credits' in modelUsage && typeof modelUsage.credits === 'number' && Number.isFinite(modelUsage.credits)) {
    return modelUsage.credits;
  }
  return undefined;
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, {once: true});
  });
}

interface SseFrame {event: string; id?: string; data: Record<string, unknown>}

async function *readSse(response: Response): AsyncIterable<SseFrame> {
  if (!response.body) throw new QoderHttpError(response.status, 'Qoder SSE 没有响应体');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, {stream: true}).replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseSseFrame(raw);
        if (frame) yield frame;
        index = buffer.indexOf('\n\n');
      }
    }
    const tail = parseSseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(raw: string): SseFrame | undefined {
  let event = '';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!event && dataLines.length === 0) return undefined;
  const joined = dataLines.join('\n');
  let data: Record<string, unknown> = {};
  if (joined) {
    try {
      const parsed: unknown = JSON.parse(joined);
      if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>;
    } catch { data = {message: joined}; }
  }
  return {event: event || stringField(data, 'type') || 'message', ...(id ? {id} : {}), data};
}
