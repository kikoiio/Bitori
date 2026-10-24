import {execFile} from 'node:child_process';
import {hookEvents, type HookConfig, type HookContext, type HookEvent, type HookResult} from './types.js';

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

/** [s11] 解析 ==/!=/=~/~= 与 &&/||；and/or 不可混用。 */
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

/** [s11] 事件、动作必填、拦截事件与 async 约束在构造前统一校验。 */
export function validateHooks(hooks: readonly HookConfig[]): Error | null {
  for (const [index, hook] of hooks.entries()) {
    if (!hookEvents.includes(hook.event)) return new Error(`Hook ${index} 事件无效：${String(hook.event)}`);
    if (hook.action.type === 'command' && !hook.action.command) return new Error(`Hook ${index} command 动作缺少 command`);
    if (hook.action.type === 'prompt' && !hook.action.prompt) return new Error(`Hook ${index} prompt 动作缺少 prompt`);
    if (hook.action.type === 'http' && !hook.action.url) return new Error(`Hook ${index} http 动作缺少 url`);
    if (hook.event === 'pre_tool_use' && hook.async) return new Error('pre_tool_use Hook 不允许 async');
    if ((hook.reject || hook.async) && hook.event !== 'pre_tool_use' && hook.event !== 'permission_request') return new Error('reject/async 只能用于拦截类事件');
  }
  return null;
}

function run(command: string, context: HookContext, timeoutMs: number): Promise<HookResult> {
  return new Promise(resolve => {
    const expanded = expand(command, context);
    const space = expanded.indexOf(' ');
    const file = space === -1 ? expanded : expanded.slice(0, space);
    const args = space === -1 ? [] : [expanded.slice(space + 1)];
    execFile(file, args, {timeout: timeoutMs, shell: process.platform === 'win32'}, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({output, success: error === null, reject: false});
    });
  });
}

/** [s11] Hook 引擎：条件过滤、once、async、通知队列与 pre_tool_use 拦截。 */
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

  async fire(event: HookEvent, context: HookContext = {event}): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const [index, hook] of this.#hooks.entries()) {
      if (hook.event !== event) continue;
      const key = hook.id ?? `${event}:${index}`;
      if (hook.once && this.#firedOnce.has(key)) continue;
      if (hook.condition && !evaluateCondition(hook.condition, context)) continue;
      if (hook.once) this.#firedOnce.add(key);
      const promise = this.#execute(hook, context);
      if (hook.async) void promise.catch(() => undefined);
      else results.push(await promise);
    }
    return results;
  }

  async firePreToolHooks(toolName: string, args: Record<string, unknown>): Promise<{rejected: boolean; reason: string}> {
    const results = await this.fire('pre_tool_use', {event: 'pre_tool_use', toolName, args});
    const rejected = results.find(result => result.reject);
    return rejected ? {rejected: true, reason: rejected.output} : {rejected: false, reason: ''};
  }

  async #execute(hook: HookConfig, context: HookContext): Promise<HookResult> {
    try {
      if (hook.action.type === 'command') {
        const result = await run(hook.action.command!, context, hook.timeoutMs ?? 10_000);
        return {...result, reject: hook.reject === true};
      }
      if (hook.action.type === 'prompt') {
        const output = expand(hook.action.prompt!, context);
        this.recordNotification(output);
        return {output, success: true, reject: hook.reject === true};
      }
      if (hook.action.type === 'http') {
        const response = await this.fetchImpl(hook.action.url!, {method: hook.action.method ?? 'POST', body: JSON.stringify(context)});
        const output = await response.text();
        return {output, success: response.ok, reject: hook.reject === true && !response.ok};
      }
      return {output: 'Agent Hook 将在 SubAgent 阶段实现', success: true, reject: false};
    } catch (error) {
      return {output: error instanceof Error ? error.message : String(error), success: false, reject: false};
    }
  }
}
