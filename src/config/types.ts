/** [s01]
 * 配置层的纯类型与小型转换函数。
 * `as const` 会把数组元素保留为字符串字面量，而不是扩大成普通 string。
 */
export const protocols = ['anthropic', 'openai-responses', 'openai-chat'] as const;

// [s01] 从只读数组推导出联合类型：'anthropic' | 'openai-responses' | 'openai-chat'。
export type Protocol = (typeof protocols)[number];

/** [s01] YAML 中允许用户书写的原始 thinking 形状，字段名保持 snake_case。 */
export type ThinkingConfigSource =
  | boolean
  | {type: 'adaptive'}
  | {type: 'manual'; budget_tokens: number; max_tokens: number};

/** [s01] 程序内部统一使用的 thinking 形状，字段名改为 TypeScript 常见的 camelCase。 */
export type ThinkingConfig =
  | {type: 'disabled'}
  | {type: 'auto'}
  | {type: 'adaptive'}
  | {type: 'manual'; budgetTokens: number; maxTokens: number};

/** [s01] 配置文件刚解析完成、API Key 仍是环境变量引用时的 profile。 */
export interface ProviderProfileSource {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: ThinkingConfigSource;
}

/** [s01] 完成校验、密钥替换和字段标准化后，应用实际使用的 profile。 */
export interface ProviderProfile {
  name: string;
  protocol: Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingConfig;
}

// [s01] Pick 从完整类型中只取 UI 真正需要且可以安全展示的字段，避免 API Key 泄漏到界面层。
export type ProfileSummary = Pick<ProviderProfile, 'name' | 'protocol' | 'model'>;

export interface AppConfig {
  profiles: ProviderProfile[];
}

export interface ParsedConfig {
  profiles: ProviderProfileSource[];
}

export function toProfileSummary(profile: ProviderProfile): ProfileSummary {
  return {name: profile.name, protocol: profile.protocol, model: profile.model};
}
