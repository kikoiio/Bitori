import {z} from 'zod';
import type {ParsedConfig, ProviderProfileSource, ThinkingConfig} from './types.js';

// [s01] API Key 必须写成完整的 ${ENV_NAME}，不能把真实密钥直接放入 YAML。
const environmentReference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const manualThinkingSchema = z
  .object({
    type: z.literal('manual'),
    budget_tokens: z.number().int().min(1024),
    max_tokens: z.number().int().positive(),
  })
  .refine(value => value.budget_tokens < value.max_tokens, {
    message: 'thinking.budget_tokens 必须小于 thinking.max_tokens',
  });

const thinkingSchema = z.union([
  z.boolean(),
  z.object({type: z.literal('adaptive')}),
  manualThinkingSchema,
]);

const profileSchema = z.object({
  name: z.string().trim().min(1, 'name 不能为空'),
  protocol: z.enum(['anthropic', 'openai-responses', 'openai-chat']),
  model: z.string().trim().min(1, 'model 不能为空'),
  base_url: z.url().refine(value => /^https?:\/\//i.test(value), 'base_url 必须使用 HTTP(S)'),
  api_key: z.string().regex(environmentReference, 'api_key 必须完整使用 ${ENV_NAME} 引用'),
  thinking: thinkingSchema.optional(),
});

export const configSchema = z
  .object({profiles: z.array(profileSchema).min(1, '至少需要一个 profile')})
  .superRefine((value, context) => {
    // [s01] superRefine 适合做跨字段/跨数组项校验：单个字段的 schema 无法判断名称是否重复。
    const names = new Set<string>();
    for (const [index, profile] of value.profiles.entries()) {
      if (names.has(profile.name)) {
        context.addIssue({
          code: 'custom',
          message: `profile 名称重复：${profile.name}`,
          path: ['profiles', index, 'name'],
        });
      }
      names.add(profile.name);
      if (profile.protocol !== 'anthropic' && profile.thinking !== undefined && profile.thinking !== false) {
        context.addIssue({
          code: 'custom',
          message: 'thinking 只能用于 anthropic profile',
          path: ['profiles', index, 'thinking'],
        });
      }
    }
  });

export function parseConfig(value: unknown): ParsedConfig {
  // [s01] 外部输入先视为 unknown；只有 Zod 校验成功后才进入有类型保证的应用代码。
  return configSchema.parse(value) as ParsedConfig;
}

/** [s01] 把面向 YAML 的多种简写归一化成 Provider 只需处理的判别联合。 */
export function normalizeThinking(source: ProviderProfileSource['thinking']): ThinkingConfig {
  if (source === true) return {type: 'auto'};
  if (source === false || source === undefined) return {type: 'disabled'};
  if (source.type === 'adaptive') return {type: 'adaptive'};
  return {type: 'manual', budgetTokens: source.budget_tokens, maxTokens: source.max_tokens};
}
