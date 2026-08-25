import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parse as parseEnv} from 'dotenv';
import {parse as parseYaml} from 'yaml';
import {ZodError} from 'zod';
import {ConfigurationError} from '../shared/errors.js';
import {normalizeThinking, parseConfig} from './schema.js';
import type {AppConfig, ProviderProfile} from './types.js';

export interface ConfigPaths {
  directory: string;
  config: string;
  environment: string;
  database: string;
}

/** [s01] 所有配置路径都固定在用户主目录的 `.mycode` 中，不受当前工作目录影响。 */
export function configPaths(homeDirectory = homedir()): ConfigPaths {
  const directory = join(homeDirectory, '.mycode');
  return {
    directory,
    config: join(directory, 'config.yaml'),
    environment: join(directory, '.env'),
    database: join(directory, 'mycode.db'),
  };
}

function readRequired(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError(`无法读取${label}：${path}`, {cause: error});
  }
}

export function loadConfig(homeDirectory = homedir()): AppConfig {
  const paths = configPaths(homeDirectory);
  const yamlText = readRequired(paths.config, '配置文件');
  const environmentText = readRequired(paths.environment, '密钥文件');
  const environment = parseEnv(environmentText);

  try {
    // [s01] YAML 解析只负责“语法”，parseConfig 再负责“结构和业务规则”。
    const parsed = parseConfig(parseYaml(yamlText));
    const profiles: ProviderProfile[] = parsed.profiles.map(source => {
      // [s01] `${NAME}` 去掉前后两个字符，得到 .env 中真正的变量名 NAME。
      const variable = source.api_key.slice(2, -1);
      const apiKey = environment[variable];
      if (apiKey === undefined || apiKey.length === 0) {
        throw new ConfigurationError(`.env 中缺少 ${variable}`);
      }
      return {
        name: source.name,
        protocol: source.protocol,
        model: source.model,
        baseUrl: source.base_url,
        apiKey,
        thinking: normalizeThinking(source.thinking),
      };
    });
    return {profiles};
  } catch (error) {
    // [s01] 已经是面向用户的配置错误就原样保留；Zod 错误则合并所有校验消息。
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof ZodError) {
      throw new ConfigurationError(`配置无效：${error.issues.map(issue => issue.message).join('；')}`);
    }
    throw new ConfigurationError('配置文件不是有效的 YAML', {cause: error});
  }
}

export function resolveProfile(config: AppConfig, requestedName?: string): ProviderProfile | null {
  if (requestedName !== undefined) {
    const profile = config.profiles.find(item => item.name === requestedName);
    if (profile === undefined) throw new ConfigurationError(`找不到 profile：${requestedName}`);
    return profile;
  }
  // [s01] 多 profile 且用户未指定时返回 null，表示应该进入 profile 选择界面。
  // [s01] `!` 告诉 TS：长度已经确认是 1，所以第 0 项一定存在。
  return config.profiles.length === 1 ? config.profiles[0]! : null;
}
