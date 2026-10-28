import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseYaml} from 'yaml';
import {z} from 'zod';
import {validateHooks} from './engine.js';
import type {HookConfig, HookEvent} from './types.js';

const actionSchema = z.union([
  z.strictObject({type: z.literal('command'), command: z.string().trim().min(1)}),
  z.strictObject({type: z.literal('prompt'), prompt: z.string().trim().min(1)}),
  z.strictObject({type: z.literal('http'), url: z.string().trim().min(1), method: z.string().trim().min(1).optional()}),
  z.strictObject({type: z.literal('agent'), prompt: z.string().trim().min(1)}),
]);
const hookSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  event: z.string().trim().min(1),
  condition: z.string().trim().min(1).optional(),
  action: actionSchema,
  reject: z.boolean().optional(),
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
  let hooks: Array<Omit<HookConfig, 'event' | 'timeoutMs'> & {event: string; timeout_ms?: number}>;
  try { hooks = z.array(hookSchema).parse(parsed) as Array<Omit<HookConfig, 'event' | 'timeoutMs'> & {event: string; timeout_ms?: number}>; }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new Error(`${label} Hook 配置无效（${path}）：${error.issues.map(issue => `${issue.path.join('.') || 'hook'} ${issue.message}`).join('；')}`, {cause: error});
  }
  const normalized: HookConfig[] = hooks.map(hook => ({...hook, event: hook.event as HookEvent, ...(hook.timeout_ms === undefined ? {} : {timeoutMs: hook.timeout_ms})}));
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
