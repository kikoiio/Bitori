import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {z} from 'zod';
import {validateHooks} from './engine.js';
import {hookEvents, type HookConfig} from './types.js';

const actionSchema = z.union([
  z.strictObject({type: z.literal('command'), command: z.string().trim().min(1), args: z.array(z.string()).optional()}),
  z.strictObject({type: z.literal('prompt'), prompt: z.string().trim().min(1)}),
  z.strictObject({type: z.literal('http'), url: z.string().trim().min(1), method: z.string().trim().min(1).optional()}),
]);
const hookSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  event: z.enum(hookEvents),
  condition: z.string().trim().min(1).optional(),
  action: actionSchema,
  reject: z.boolean().optional(),
  failure_policy: z.enum(['open', 'closed']).optional(),
  once: z.boolean().optional(),
  async: z.boolean().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

function readHooks(path: string, label: string): HookConfig[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try { parsed = parseYaml(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new Error(`${label} Hook 配置不是有效 YAML（${path}）：${error instanceof Error ? error.message : String(error)}`, {cause: error});
  }
  let hooks: z.infer<typeof hookSchema>[];
  try { hooks = z.array(hookSchema).parse(parsed); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new Error(`${label} Hook 配置无效（${path}）：${error.issues.map(issue => `${issue.path.join('.') || 'hook'} ${issue.message}`).join('；')}`, {cause: error});
  }
  const normalized: HookConfig[] = hooks.map(hook => ({
    event: hook.event,
    action: hook.action.type === 'http'
      ? {type: 'http', url: hook.action.url, ...(hook.action.method === undefined ? {} : {method: hook.action.method})}
      : hook.action.type === 'command'
        ? {type: 'command', command: hook.action.command, ...(hook.action.args === undefined ? {} : {args: hook.action.args})}
        : hook.action,
    ...(hook.id === undefined ? {} : {id: hook.id}),
    ...(hook.condition === undefined ? {} : {condition: hook.condition}),
    ...(hook.reject === undefined ? {} : {reject: hook.reject}),
    ...(hook.once === undefined ? {} : {once: hook.once}),
    ...(hook.async === undefined ? {} : {async: hook.async}),
    ...(hook.timeout_ms === undefined ? {} : {timeoutMs: hook.timeout_ms}),
    ...(hook.failure_policy === undefined ? {} : {failurePolicy: hook.failure_policy}),
  }));
  const error = validateHooks(normalized);
  if (error) throw new Error(`${label} Hook 配置无效（${path}）：${error.message}`);
  return normalized;
}

/** 用户级先加载，项目级追加；once id 在合并集合内全局生效。 */
export function loadHookConfigs(workDir = process.cwd(), home = homedir()): HookConfig[] {
  return [
    ...readHooks(join(home, '.bitori', 'hooks.yaml'), '用户级'),
    ...readHooks(join(workDir, '.bitori', 'hooks.yaml'), '项目级'),
  ];
}
