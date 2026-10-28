import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {parse as parseEnv} from 'dotenv';
import {parse as parseYaml} from 'yaml';
import {ZodError} from 'zod';
import {ConfigurationError} from '../shared/errors.js';
import {normalizeThinking, parseConfig, parseProjectConfig} from './schema.js';
import {effectiveContextWindow, type AppConfig, type McpServerConfig, type McpServerConfigSource, type ProviderProfile} from './types.js';

export interface ConfigPaths {
  directory: string;
  config: string;
  environment: string;
  database: string;
  /** 可观察性数据的固定落点：日志、请求级 trace 与使用统计。 */
  logs: string;
  traces: string;
  usage: string;
}

const environmentInterpolation = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 所有配置路径都固定在用户主目录的 `.bitori` 中，不受当前工作目录影响。 */
export function configPaths(homeDirectory = homedir()): ConfigPaths {
  const directory = join(homeDirectory, '.bitori');
  return {
    directory,
    config: join(directory, 'config.yaml'),
    environment: join(directory, '.env'),
    database: join(directory, 'bitori.db'),
    logs: join(directory, 'logs'),
    traces: join(directory, 'traces'),
    usage: join(directory, 'usage'),
  };
}

function readRequired(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`无法读取${label}：${path}`, {cause: error});
  }
}

function readProjectConfig(path: string): ReturnType<typeof parseProjectConfig> {
  if (!existsSync(path)) return {};
  try { return parseProjectConfig(parseYaml(readFileSync(path, 'utf8'))); }
  catch (error) {
    if (error instanceof ZodError) throw new ConfigurationError(`项目级配置无效（${path}）：${error.issues.map(issue => issue.message).join('；')}`);
    throw new ConfigurationError(`项目级配置不是有效 YAML：${path}`, {cause: error});
  }
}

/** 对 MCP 的 env/header 做可嵌入式 ${VAR} 展开，缺失变量必须在启动时显错。 */
function expand(value: string, environment: NodeJS.ProcessEnv, location: string): string {
  return value.replace(environmentInterpolation, (_whole, name: string) => {
    const resolved = environment[name];
    if (resolved === undefined) throw new ConfigurationError(`${location} 引用了未定义的环境变量 ${name}`);
    return resolved;
  });
}

function resolveMcpServer(name: string, source: McpServerConfigSource, environment: NodeJS.ProcessEnv): McpServerConfig {
  if (source.transport === 'stdio') {
    const command = expand(source.command, environment, `MCP Server ${name}.command`);
    if (command.trim().length === 0) throw new ConfigurationError(`MCP Server ${name}.command 展开后不能为空`);
    return {
      transport: 'stdio',
      command,
      args: (source.args ?? []).map((value, index) => expand(value, environment, `MCP Server ${name}.args[${index}]`)),
      env: Object.fromEntries(Object.entries(source.env ?? {}).map(([key, value]) => [key, expand(value, environment, `MCP Server ${name}.env.${key}`)])),
    };
  }
  const url = expand(source.url, environment, `MCP Server ${name}.url`);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new ConfigurationError(`MCP Server ${name}.url 必须是展开后的有效 HTTP(S) URL`);
  }
  return {
    transport: 'http',
    url,
    headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([key, value]) => [key, expand(value, environment, `MCP Server ${name}.headers.${key}`)])),
  };
}

export function loadConfig(homeDirectory = homedir(), workspaceRoot = process.cwd(), runtimeEnvironment: NodeJS.ProcessEnv = process.env): AppConfig {
  const paths = configPaths(homeDirectory);
  const yamlText = readRequired(paths.config, '配置文件');
  const environmentText = readRequired(paths.environment, '密钥文件');
  // 实际进程环境优先于 .env，便于 CI/终端临时覆盖 MCP 凭据。
  const environment: NodeJS.ProcessEnv = {...parseEnv(environmentText), ...runtimeEnvironment};

  try {
    // YAML 解析只负责“语法”，parseConfig 再负责“结构和业务规则”。
    const parsed = parseConfig(parseYaml(yamlText));
    const projectPath = join(workspaceRoot, '.bitori', 'config.yaml');
    // 工作区为主目录时，同一文件只按用户配置解析，避免项目级严格校验重复读取。
    const sameConfig = resolve(projectPath) === resolve(paths.config) || (existsSync(projectPath) && realpathSync(projectPath) === realpathSync(paths.config));
    const project = sameConfig ? {} : readProjectConfig(projectPath);
    const profiles: ProviderProfile[] = parsed.profiles.map(source => {
      // `${NAME}` 去掉前后两个字符，得到 .env 中真正的变量名 NAME。
      const variable = source.api_key.slice(2, -1);
      const apiKey = environment[variable];
      // 缺失的 key 先置空；真正使用该 profile 时 resolveProfileWithApiKey 会显错。
      return {
        name: source.name,
        protocol: source.protocol,
        model: source.model,
        baseUrl: source.base_url,
        apiKey: apiKey === undefined ? '' : apiKey,
        thinking: normalizeThinking(source.thinking),
        contextWindow: effectiveContextWindow(source.protocol, source.context_window),
      };
    });
    // map 按 user → project 浅合并；同名 Server 由项目级完整覆盖。
    const sources = {...(parsed.mcp_servers ?? {}), ...(project.mcp_servers ?? {})};
    const mcpServers = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, resolveMcpServer(name, source, environment)]));
    return {profiles, mcpServers, models: parsed.models ?? {}, logging: parsed.logging ?? {}, trace: parsed.trace ?? {}};
  } catch (error) {
    // 已经是面向用户的配置错误就原样保留；Zod 错误则合并所有校验消息。
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof ZodError) {
      throw new ConfigurationError(`配置无效：${error.issues.map(issue => issue.message).join('；')}`);
    }
    throw new ConfigurationError('配置文件不是有效的 YAML', {cause: error});
  }
}

/** 读取 `.env` 的全部键值作为脱敏字典来源；只用于替换，不回显。 */
export function readEnvironmentSecrets(homeDirectory = homedir()): string[] {
  try {
    const text = readFileSync(configPaths(homeDirectory).environment, 'utf8');
    return Object.values(parseEnv(text)).filter((value): value is string => value !== undefined && value.length > 0);
  } catch {
    return [];
  }
}

/** 在解析 profile 的同时收集全部已解析密钥值，供 Redactor 与 trace 使用。 */
export function collectSecretValues(config: AppConfig, homeDirectory = homedir()): string[] {
  return [...readEnvironmentSecrets(homeDirectory), ...config.profiles.map(profile => profile.apiKey).filter(key => key.length > 0)];
}

export function resolveProfile(config: AppConfig, requestedName?: string): ProviderProfile | null {
  if (requestedName !== undefined) {
    const profile = config.profiles.find(item => item.name === requestedName);
    if (profile === undefined) throw new ConfigurationError(`找不到 profile：${requestedName}`);
    return profile;
  }
  // 多 profile 且用户未指定时返回 null，表示应该进入 profile 选择界面。
  return config.profiles.length === 1 ? config.profiles[0]! : null;
}

/**
 * 仅按需解析 profile 的密钥：缺失 key 的 profile 不阻塞启动，但一旦被选中就立即显错。
 * 这样用户可以先只填 OpenRouter 或只填 Groq。
 */
export function resolveProfileWithApiKey(config: AppConfig, requestedName?: string): ProviderProfile | null {
  const profile = resolveProfile(config, requestedName);
  if (profile === null || profile.apiKey.length > 0) return profile;
  throw new ConfigurationError(`.env 中缺少 profile ${profile.name} 的 API key`);
}
