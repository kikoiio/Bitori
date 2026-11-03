import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isWorkspaceTrusted} from './trust.js';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {parse as parseEnv} from 'dotenv';
import {parse as parseYaml} from 'yaml';
import {ZodError} from 'zod';
import {ConfigurationError} from '../shared/errors.js';
import {defaultUserConfigYaml, defaultUserEnv} from './defaults.js';
import {normalizeThinking, parseConfig, parseProjectConfig} from './schema.js';
import {effectiveContextWindow, protocols, type AppConfig, type McpServerConfig, type McpServerConfigSource, type Protocol, type ProviderProfile} from './types.js';

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

function writeIfAbsent(path: string, content: string, mode: number): boolean {
  try {
    writeFileSync(path, content, {encoding: 'utf8', flag: 'wx', mode});
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

/** 缺少用户配置时写入通用模板，不覆盖已有文件。 */
export function ensureUserConfigFiles(homeDirectory = homedir()): {config: string; environment: string; created: boolean} {
  const paths = configPaths(homeDirectory);
  mkdirSync(paths.directory, {recursive: true, mode: 0o700});
  const wroteConfig = writeIfAbsent(paths.config, defaultUserConfigYaml, 0o600);
  const wroteEnvironment = writeIfAbsent(paths.environment, defaultUserEnv, 0o600);
  return {config: paths.config, environment: paths.environment, created: wroteConfig || wroteEnvironment};
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

function httpUrlOrThrow(value: string, location: string): string {
  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new ConfigurationError(`${location} 必须是展开后的有效 HTTP(S) URL`);
  }
  return url;
}

function expandHttpUrl(value: string, environment: NodeJS.ProcessEnv, location: string): string {
  return httpUrlOrThrow(expand(value, environment, location), location);
}

/** profile 的 model/base_url 允许指向未填写的变量：标记为 missing，选中该 profile 时才报错，模板不再阻塞启动。 */
function softExpand(value: string, environment: NodeJS.ProcessEnv): {resolved?: string; missing: string[]} {
  const missing: string[] = [];
  const resolved = value.replace(environmentInterpolation, (_whole, name: string) => {
    const candidate = environment[name];
    // 空字符串按“未填写”处理：模板里的 `LLM_API_KEY=` 不应该阻塞其他 Provider 的启动。
    if (candidate === undefined || candidate.trim().length === 0) { missing.push(name); return ''; }
    return candidate;
  });
  return missing.length === 0 ? {resolved, missing: []} : {missing};
}

/** <前缀>_API_KEY + <前缀>_MODEL（+ 可选 _BASE_URL/_PROTOCOL）自动派生 profile，用户只需要填 .env。 */
const envGroupPattern = /^(.+)_(API_KEY|BASE_URL|MODEL|PROTOCOL)$/;
const protocolBaseDefaults: Partial<Record<Protocol, string>> = {
  // Anthropic SDK 自己拼 /v1/messages，base_url 只能是接口根，否则会变成 /v1/v1/messages。
  anthropic: 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
};

function deriveProfilesFromEnvironment(environment: NodeJS.ProcessEnv, explicit: ProviderProfile[]): {profiles: ProviderProfile[]; notes: string[]} {
  interface Group {key?: [string, string]; base?: [string, string]; model?: [string, string]; protocol?: [string, string]}
  const groups = new Map<string, Group>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.trim().length === 0) continue;
    const match = envGroupPattern.exec(name);
    if (match === null) continue;
    const prefix = match[1]!;
    if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) continue;
    const group = groups.get(prefix) ?? {};
    const pair = [name, value] as [string, string];
    if (match[2] === 'API_KEY') group.key = pair;
    else if (match[2] === 'BASE_URL') group.base = pair;
    else if (match[2] === 'MODEL') group.model = pair;
    else group.protocol = pair;
    groups.set(prefix, group);
  }
  const explicitKeyVars = new Set(explicit.map(item => item.apiKeyVariable));
  const explicitNames = new Set(explicit.map(item => item.name));
  const profiles: ProviderProfile[] = [];
  const notes: string[] = [];
  for (const [prefix, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.key === undefined) {
      // 单个散变量（如 GITHUB_API_KEY）太常见，只在像故意组成一组（≥2 项）时才提示。
      const members = [group.base, group.model, group.protocol].filter(Boolean).length;
      if (members >= 2) notes.push(`变量组 ${prefix}_* 缺少 ${prefix}_API_KEY，未派生 profile`);
      continue;
    }
    // 显式 profile 已经引用了这个 key 变量：以 config.yaml 为准，不重复派生。
    if (explicitKeyVars.has(group.key[0])) continue;
    let protocol: Protocol = 'openai-chat';
    if (group.protocol !== undefined) {
      if (!(protocols as readonly string[]).includes(group.protocol[1])) {
        notes.push(`变量组 ${prefix}_* 的 ${group.protocol[0]}=${group.protocol[1]} 不是支持的协议（${protocols.join(' | ')}），未派生`);
        continue;
      }
      protocol = group.protocol[1] as Protocol;
    }
    if (group.model === undefined) {
      // 只有 key 的散变量（如 GITHUB_API_KEY）太常见，沉默；像故意成组的才提示。
      if (group.base !== undefined || group.protocol !== undefined) notes.push(`变量组 ${prefix}_* 缺少 ${prefix}_MODEL，未派生 profile`);
      continue;
    }
    let baseUrl = group.base?.[1];
    if (baseUrl === undefined) {
      const fallback = protocolBaseDefaults[protocol];
      if (fallback === undefined) {
        notes.push(`变量组 ${prefix}_* 的协议 ${protocol} 必须提供 ${prefix}_BASE_URL，未派生`);
        continue;
      }
      baseUrl = fallback;
    }
    try { baseUrl = httpUrlOrThrow(baseUrl, `${prefix}_BASE_URL`); }
    catch (error) { notes.push(`${error instanceof Error ? error.message : String(error)}，未派生 ${prefix} profile`); continue; }
    const name = prefix.toLowerCase();
    if (explicitNames.has(name)) {
      notes.push(`变量组 ${prefix}_* 与 config.yaml 中 profile ${name} 同名，以显式定义为准`);
      continue;
    }
    profiles.push({
      name,
      protocol,
      model: group.model[1].trim(),
      baseUrl,
      apiKey: group.key[1],
      apiKeyVariable: group.key[0],
      thinking: {type: 'disabled'},
      contextWindow: effectiveContextWindow(protocol),
    });
  }
  return {profiles, notes};
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
  const url = expandHttpUrl(source.url, environment, `MCP Server ${name}.url`);
  return {
    transport: 'http',
    url,
    headers: Object.fromEntries(Object.entries(source.headers ?? {}).map(([key, value]) => [key, expand(value, environment, `MCP Server ${name}.headers.${key}`)])),
  };
}

export function loadConfig(homeDirectory = homedir(), workspaceRoot = process.cwd(), runtimeEnvironment: NodeJS.ProcessEnv = process.env): AppConfig {
  const paths = configPaths(homeDirectory);
  const scaffold = ensureUserConfigFiles(homeDirectory);
  if (scaffold.created) {
    throw new ConfigurationError(`已创建 ${scaffold.config} 和 ${scaffold.environment}。请在 ${scaffold.environment} 填一组变量：任意大写前缀 + _API_KEY、_BASE_URL、_MODEL（例如 OPENROUTER_API_KEY / OPENROUTER_BASE_URL / OPENROUTER_MODEL），保存后运行 bitori doctor 验证`);
  }
  const yamlText = readRequired(paths.config, '配置文件');
  const environmentText = readRequired(paths.environment, '密钥文件');
  // 实际进程环境优先于 .env，便于 CI/终端临时覆盖配置值。
  const environment: NodeJS.ProcessEnv = {...parseEnv(environmentText), ...runtimeEnvironment};

  try {
    // YAML 解析只负责“语法”，parseConfig 再负责“结构和业务规则”。
    const parsed = parseConfig(parseYaml(yamlText));
    const projectPath = join(workspaceRoot, '.bitori', 'config.yaml');
    // 工作区为主目录时，同一文件只按用户配置解析，避免项目级严格校验重复读取。
    const sameConfig = resolve(projectPath) === resolve(paths.config) || (existsSync(projectPath) && realpathSync(projectPath) === realpathSync(paths.config));
    const notices: string[] = [];
    let project: ReturnType<typeof parseProjectConfig> = {};
    if (!sameConfig && existsSync(projectPath)) {
      if (isWorkspaceTrusted(workspaceRoot, homeDirectory)) project = readProjectConfig(projectPath);
      else notices.push(`工作区未信任：已跳过项目级 ${projectPath}（项目 MCP 不会启动）。确认后运行 bitori trust ${workspaceRoot}`);
    }
    const explicitProfiles: ProviderProfile[] = parsed.profiles.map(source => {
      const modelExpansion = softExpand(source.model, environment);
      const urlExpansion = softExpand(source.base_url, environment);
      const missingVariables = [...new Set([...modelExpansion.missing, ...urlExpansion.missing])];
      let model = '';
      if (modelExpansion.resolved !== undefined) {
        model = modelExpansion.resolved.trim();
        if (model.length === 0) throw new ConfigurationError(`profile ${source.name}.model 展开后不能为空`);
      }
      const baseUrl = urlExpansion.resolved === undefined ? '' : httpUrlOrThrow(urlExpansion.resolved, `profile ${source.name}.base_url`);
      // `${NAME}` 去掉前后两个字符，得到 .env 中真正的变量名 NAME。
      const variable = source.api_key.slice(2, -1);
      const apiKey = environment[variable];
      // 缺失的 key/model/base_url 都先标记；真正使用该 profile 时 resolveProfileWithApiKey 会指名缺哪个变量。
      return {
        name: source.name,
        protocol: source.protocol,
        model,
        baseUrl,
        apiKey: apiKey === undefined ? '' : apiKey,
        apiKeyVariable: variable,
        thinking: normalizeThinking(source.thinking),
        contextWindow: effectiveContextWindow(source.protocol, source.context_window),
        ...(missingVariables.length === 0 ? {} : {missingVariables}),
      };
    });
    const derived = deriveProfilesFromEnvironment(environment, explicitProfiles);
    const profiles = [...explicitProfiles, ...derived.profiles];
    notices.push(...derived.notes);
    if (profiles.length === 0) throw new ConfigurationError('没有可用 profile：在 .env 填一组 <前缀>_API_KEY + <前缀>_MODEL（如 OPENROUTER_API_KEY / OPENROUTER_MODEL / OPENROUTER_BASE_URL），或在 config.yaml 定义 profile');
    // map 按 user → project 浅合并；同名 Server 由项目级完整覆盖。
    const sources = {...(parsed.mcp_servers ?? {}), ...(project.mcp_servers ?? {})};
    const mcpServers = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, resolveMcpServer(name, source, environment)]));
    const workspaceHooksPath = join(workspaceRoot, '.bitori', 'hooks.yaml');
    if (!isWorkspaceTrusted(workspaceRoot, homeDirectory) && !sameConfig && existsSync(workspaceHooksPath)) notices.push(`工作区未信任：已跳过项目级 ${workspaceHooksPath}。确认后运行 bitori trust ${workspaceRoot}`);
    return {profiles, mcpServers, models: parsed.models ?? {}, logging: parsed.logging ?? {}, trace: parsed.trace ?? {}, ...(notices.length ? {notices} : {})};
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
  const mcpValues = Object.values(config.mcpServers).flatMap(server => server.transport === 'http'
    ? [server.url, ...Object.values(server.headers)]
    : [server.command, ...server.args, ...Object.values(server.env)]);
  return [...readEnvironmentSecrets(homeDirectory), ...config.profiles.map(profile => profile.apiKey), ...mcpValues].filter(value => value.length > 0);
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
 */
export function resolveProfileWithApiKey(config: AppConfig, requestedName?: string): ProviderProfile | null {
  const profile = resolveProfile(config, requestedName);
  if (profile === null) return null;
  const missing: string[] = [];
  if (profile.missingVariables !== undefined) missing.push(...profile.missingVariables);
  if (profile.apiKey.length === 0) missing.push(profile.apiKeyVariable ?? 'API key');
  if (missing.length > 0) throw new ConfigurationError(`请在 .env 中填写 ${missing.join('、')}（profile ${profile.name} 尚不可用）`);
  return profile;
}
