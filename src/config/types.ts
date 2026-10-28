/**
 * 配置层的纯类型与小型转换函数。
 */
export const protocols = ['anthropic', 'openai-responses', 'openai-chat'] as const;

export type Protocol = (typeof protocols)[number];

/** YAML 中允许用户书写的原始 thinking 形状，字段名保持 snake_case。 */
export type ThinkingConfigSource =
  | boolean
  | {type: 'adaptive'}
  | {type: 'manual'; budget_tokens: number; max_tokens: number};

/** 程序内部统一使用的 thinking 形状，字段名为 camelCase。 */
export type ThinkingConfig =
  | {type: 'disabled'}
  | {type: 'auto'}
  | {type: 'adaptive'}
  | {type: 'manual'; budgetTokens: number; maxTokens: number};

/** 配置文件刚解析完成、API Key 仍是环境变量引用时的 profile。 */
export interface ProviderProfileSource {
  name: string;
  protocol: Protocol;
  model: string;
  base_url: string;
  api_key: string;
  thinking?: ThinkingConfigSource;
  /** token 上限；未配置时按协议默认值处理。 */
  context_window?: number;
}

/** 完成校验、密钥替换和字段标准化后，应用实际使用的 profile。 */
export interface ProviderProfile {
  name: string;
  protocol: Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingConfig;
  /** 未配置时由 effectiveContextWindow 给出协议默认值。 */
  contextWindow?: number;
}

/** MCP Server 配置以名称为键；项目级同名项会完整覆盖用户级项。 */
export type McpServerConfig =
  | {transport: 'stdio'; command: string; args: string[]; env: Record<string, string>}
  | {transport: 'http'; url: string; headers: Record<string, string>};

/** YAML 校验后的配置仍保留待展开字符串，loader 统一处理环境变量。 */
export type McpServerConfigSource =
  | {transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>}
  | {transport: 'http'; url: string; headers?: Record<string, string>};

// 界面只接收可安全展示的字段，避免 API Key 泄漏。
export type ProfileSummary = Pick<ProviderProfile, 'name' | 'protocol' | 'model'>;

export interface AppConfig {
  profiles: ProviderProfile[];
  mcpServers: Record<string, McpServerConfig>;
  /** SubAgent 的逻辑模型名到 profile 名映射；缺失时回退当前 profile。 */
  models: Record<string, string>;
  /** 日志配置；字段缺省时使用 shared/logger 的默认值。 */
  logging: LoggingConfig;
  /** trace 配置；字段缺省时使用默认保留期。 */
  trace: TraceConfig;
}

/** YAML `logging:` 段的内部形状。 */
export interface LoggingConfig {
  level?: 'debug' | 'info' | 'warn' | 'error';
  retention_days?: number;
}

/** YAML `trace:` 段的内部形状。 */
export interface TraceConfig {
  retention_days?: number;
}

export interface ParsedConfig {
  profiles: ProviderProfileSource[];
  mcp_servers?: Record<string, McpServerConfigSource>;
  models?: Record<string, string>;
  logging?: LoggingConfig;
  trace?: TraceConfig;
}

/** 跨协议默认上下文窗口；配置值只做覆盖。 */
export function effectiveContextWindow(protocol: Protocol, configured?: number): number {
  if (configured && configured > 0) return configured;
  return protocol === 'anthropic' ? 200_000 : 128_000;
}

export function toProfileSummary(profile: ProviderProfile): ProfileSummary {
  return {name: profile.name, protocol: profile.protocol, model: profile.model};
}
