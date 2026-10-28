import {z} from 'zod';
import type {ParsedConfig, ProviderProfileSource, ThinkingConfig} from './types.js';

// API Key 必须写成完整的 ${ENV_NAME}，不能把真实密钥直接放入 YAML。
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
  base_url: z.string().trim().min(1, 'base_url 不能为空'),
  api_key: z.string().regex(environmentReference, 'api_key 必须完整使用 ${ENV_NAME} 引用'),
  thinking: thinkingSchema.optional(),
  context_window: z.number().int().positive().optional(),
});

const stringMapSchema = z.record(z.string(), z.string());
const stdioMcpServerSchema = z.strictObject({
  transport: z.literal('stdio'),
  command: z.string().trim().min(1, 'command 不能为空'),
  args: z.array(z.string()).optional(),
  env: stringMapSchema.optional(),
});
const httpMcpServerSchema = z.strictObject({
  transport: z.literal('http'),
  // URL 在 loader 展开 ${VAR} 后再做 HTTP(S) 校验。
  url: z.string().trim().min(1, 'MCP url 不能为空'),
  headers: stringMapSchema.optional(),
});
const mcpServersSchema = z.record(
  z.string().trim().min(1, 'MCP Server 名称不能为空'),
  z.discriminatedUnion('transport', [stdioMcpServerSchema, httpMcpServerSchema]),
);
const modelAliasesSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

/** 可观察性配置：日志级别/保留期与 trace 保留期，均可缺省。 */
const loggingSchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  retention_days: z.number().int().positive().max(365).optional(),
});
const traceSchema = z.strictObject({
  retention_days: z.number().int().positive().max(365).optional(),
});

export const configSchema = z
  .strictObject({
    profiles: z.array(profileSchema).min(1, '至少需要一个 profile'),
    mcp_servers: mcpServersSchema.optional(),
    models: modelAliasesSchema.optional(),
    logging: loggingSchema.optional(),
    trace: traceSchema.optional(),
  })
  .superRefine((value, context) => {
    // 跨配置项校验名称唯一性。
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

/** 项目级配置只承载 MCP Server，避免项目覆盖用户的供应商密钥配置。 */
export const projectConfigSchema = z.strictObject({mcp_servers: mcpServersSchema.optional()});

export function parseConfig(value: unknown): ParsedConfig {
  // 外部配置必须通过 Zod 校验后才能进入应用。
  return configSchema.parse(value) as ParsedConfig;
}

export function parseProjectConfig(value: unknown): Pick<ParsedConfig, 'mcp_servers'> {
  return projectConfigSchema.parse(value ?? {}) as Pick<ParsedConfig, 'mcp_servers'>;
}

/** 把面向 YAML 的多种简写归一化成 Provider 只需处理的判别联合。 */
export function normalizeThinking(source: ProviderProfileSource['thinking']): ThinkingConfig {
  if (source === true) return {type: 'auto'};
  if (source === false || source === undefined) return {type: 'disabled'};
  if (source.type === 'adaptive') return {type: 'adaptive'};
  return {type: 'manual', budgetTokens: source.budget_tokens, maxTokens: source.max_tokens};
}
