import {execFile} from 'node:child_process';
import {errorMessage} from '../shared/errors.js';
import {getLogger} from '../shared/logger.js';
import {hookEvents, type HookConfig, type HookContext, type HookEvent, type HookResult} from './types.js';

const logger = getLogger('hooks');

const OPERATORS = ['!=', '=~', '~=', '=='] as const;
type Operator = (typeof OPERATORS)[number];
interface Comparison {left: string; operator: Operator; right: string}
type ConditionGroup = {kind: 'and' | 'or'; comparisons: Comparison[]};

function contextValue(context: HookContext, token: string): string {
  const normalized = token.trim();
  if (normalized === '$EVENT') return context.event;
  if (normalized === '$TOOL_NAME') return context.toolName ?? '';
  if (normalized === '$FILE_PATH') return context.filePath ?? '';
  if (normalized === '$MESSAGE') return context.message ?? '';
  if (normalized === '$ERROR') return context.error ?? '';
  if (normalized.startsWith('$TOOL_ARGS.')) { const value = context.args?.[normalized.slice('$TOOL_ARGS.'.length)]; return typeof value === 'string' ? value : JSON.stringify(value ?? ''); }
  return normalized.replace(/^["']|["']$/g, '');
}

/** 解析 ==/!=/=~/~= 与 &&/||；and/or 不可混用。 */
export function parseCondition(expression: string): ConditionGroup | null {
  const separator = expression.includes('&&') && expression.includes('||') ? null : expression.includes('&&') ? '&&' : expression.includes('||') ? '||' : null;
  if (separator === null && expression.includes('&&') && expression.includes('||')) return null;
  const parts = separator === null ? [expression] : expression.split(separator);
  const comparisons: Comparison[] = [];
  for (const part of parts) {
    const operator = OPERATORS.find(candidate => part.includes(candidate));
    if (!operator) return null;
    const [left, ...rest] = part.split(operator);
    if (!left || rest.length === 0) return null;
    comparisons.push({left: left.trim(), operator, right: rest.join(operator).trim()});
  }
  return {kind: separator === '||' ? 'or' : 'and', comparisons};
}

export function evaluateCondition(expression: string, context: HookContext): boolean {
  const group = parseCondition(expression);
  if (!group) return false;
  const test = ({left, operator, right}: Comparison) => {
    const actual = contextValue(context, left);
    const expected = contextValue(context, right);
    if (operator === '==') return actual === expected.replace(/^\/|\/$/g, '');
    if (operator === '!=') return actual !== expected;
    try { return new RegExp(expected.replace(/^\/|\/$/g, '')).test(actual); }
    catch { return false; }
  };
  return group.kind === 'or' ? group.comparisons.some(test) : group.comparisons.every(test);
}

function expand(text: string, context: HookContext): string {
  return text
    .replace(/\$EVENT/g, context.event)
    .replace(/\$TOOL_NAME/g, context.toolName ?? '')
    .replace(/\$FILE_PATH/g, context.filePath ?? '')
    .replace(/\$MESSAGE/g, context.message ?? '')
    .replace(/\$ERROR/g, context.error ?? '')
    .replace(/\$TOOL_ARGS\.([A-Za-z_][A-Za-z0-9_]*)/g, (_all, key: string) => {
      const value = context.args?.[key];
      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    });
}

/** 事件、动作必填、拦截事件与 async 约束在构造前统一校验。 */
export function validateHooks(hooks: readonly HookConfig[]): Error | null {
  for (const [index, hook] of hooks.entries()) {
    if (!hookEvents.includes(hook.event)) return new Error(`Hook ${index} 事件无效：${String(hook.event)}`);
    if (hook.action.type === 'command' && !hook.action.command) return new Error(`Hook ${index} command 动作缺少 command`);
    if (hook.action.type === 'command' && [hook.action.command ?? '', ...(hook.action.args ?? [])].some(value => /\$(?:EVENT|TOOL_NAME|TOOL_ARGS\.|FILE_PATH|MESSAGE|ERROR)/.test(value))) return new Error(`Hook ${index} command 不允许插入动态上下文，请在程序中读取 BITORI_HOOK_CONTEXT 环境变量`);
    if (hook.action.type === 'prompt' && !hook.action.prompt) return new Error(`Hook ${index} prompt 动作缺少 prompt`);
    if (hook.action.type === 'http' && !hook.action.url) return new Error(`Hook ${index} http 动作缺少 url`);
    if (hook.action.type === 'agent') return new Error(`Hook ${index} agent 动作尚不支持`);
    if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs <= 0)) return new Error(`Hook ${index} timeoutMs 必须是正整数`);
    const guard = hook.event === 'pre_tool_use' || hook.event === 'permission_request';
    if (guard && hook.async) return new Error(`${hook.event} Hook 不允许 async`);
    if (hook.reject && !guard) return new Error('reject 只能用于拦截类事件');
  }
  return null;
}

function run(command: string, args: string[], context: HookContext, timeoutMs: number, signal?: AbortSignal): Promise<HookResult> {
  return new Promise(resolve => {
    execFile(command, args, {timeout: timeoutMs, shell: false, env: {...process.env, BITORI_HOOK_CONTEXT: JSON.stringify(context)}, ...(signal ? {signal} : {})}, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({output, success: error === null, reject: false});
    });
  });
}

/** Hook 引擎：条件过滤、once、async、通知队列与 pre_tool_use 拦截。 */
export class HookEngine {
  readonly #hooks: HookConfig[];
  readonly #firedOnce = new Set<string>();
  #notifications: string[] = [];

  constructor(hooks: readonly HookConfig[], private readonly fetchImpl: typeof fetch = fetch) {
    const error = validateHooks(hooks);
    if (error) throw error;
    this.#hooks = [...hooks];
  }

  recordNotification(message: string): void { this.#notifications.push(message); }
  drainNotifications(): string[] {
    const messages = this.#notifications;
    this.#notifications = [];
    return messages;
  }

  async fire(event: HookEvent, context: HookContext = {event}, signal?: AbortSignal): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const [index, hook] of this.#hooks.entries()) {
      if (hook.event !== event) continue;
      const key = hook.id ?? `${event}:${index}`;
      if (hook.once && this.#firedOnce.has(key)) continue;
      if (hook.condition && !evaluateCondition(hook.condition, context)) continue;
      if (hook.once) this.#firedOnce.add(key);
      const promise = this.#execute(hook, context, signal);
      // 异步 Hook 失败时记录警告，不阻断事件处理。
      if (hook.async) void promise.catch((error: unknown) => { logger.warn('异步 Hook 执行失败', {event, hook: key, error: errorMessage(error)}); });
      else results.push(await promise);
    }
    return results;
  }

  async guard(event: 'pre_tool_use' | 'permission_request', toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{rejected: boolean; reason: string}> {
    const results = await this.fire(event, {event, toolName, args}, signal);
    const rejected = results.find(result => result.reject);
    return rejected ? {rejected: true, reason: rejected.output} : {rejected: false, reason: ''};
  }

  async #execute(hook: HookConfig, context: HookContext, signal?: AbortSignal): Promise<HookResult> {
    // reject 拦截匹配的成功动作；失败默认关闭，可通过 failure_policy: open 明确放行。
    const rejected = (success: boolean) => hook.reject === true && (success || hook.failurePolicy !== 'open');
    try {
      if (hook.action.type === 'command') {
        const result = await run(hook.action.command!, hook.action.args ?? [], context, hook.timeoutMs ?? 10_000, signal);
        return {...result, reject: rejected(result.success)};
      }
      if (hook.action.type === 'prompt') {
        const output = expand(hook.action.prompt!, context);
        this.recordNotification(output);
        return {output, success: true, reject: rejected(true)};
      }
      if (hook.action.type === 'http') {
        const timeout = AbortSignal.timeout(hook.timeoutMs ?? 10_000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const operation = async () => {
          const response = await this.fetchImpl(hook.action.url!, {method: hook.action.method ?? 'POST', body: JSON.stringify(context), signal: requestSignal});
          const output = await response.text();
          return {output, success: response.ok, reject: rejected(response.ok)};
        };
        let abort = () => {};
        try { return await new Promise<HookResult>((resolve, reject) => {
          abort = () => reject(requestSignal.reason instanceof Error ? requestSignal.reason : new DOMException('Hook 请求已取消', 'AbortError'));
          if (requestSignal.aborted) { abort(); return; }
          requestSignal.addEventListener('abort', abort, {once: true});
          void operation().then(resolve, reject);
        }); } finally { requestSignal.removeEventListener('abort', abort); }
      }
      return {output: 'Agent Hook 暂不支持', success: false, reject: rejected(false)};
    } catch (error) {
      return {output: error instanceof Error ? error.message : String(error), success: false, reject: rejected(false)};
    }
  }
}
