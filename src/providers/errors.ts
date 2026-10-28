import type {ProviderProfile} from '../config/types.js';
import {redactSecrets} from '../config/secrets.js';

export type ProviderErrorCode =
  | 'authentication'
  | 'rate_limit'
  | 'network'
  | 'context_limit'
  | 'invalid_request'
  | 'provider_error'
  | 'unknown';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

interface ErrorShape {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
}

function shape(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? error : {};
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  const candidate = shape(error);
  return signal?.aborted === true || candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

/**
 * 把 SDK、HTTP 和网络层形态各异的错误归一化，供控制器和 UI 统一处理。
 * 错误文本在返回前还会脱敏，避免供应商把请求中的 API Key 回显出来。
 */
export function normalizeProviderError(error: unknown, profile: ProviderProfile): ProviderError {
  const candidate = shape(error);
  const statusValue = candidate.status ?? candidate.statusCode;
  const statusCode = typeof statusValue === 'number' ? statusValue : undefined;
  const rawMessage = typeof candidate.message === 'string' ? candidate.message : '未知供应商错误';
  const message = redactSecrets(rawMessage, [profile]);
  const lower = message.toLowerCase();

  let code: ProviderErrorCode = 'unknown';
  if (statusCode === 401 || statusCode === 403) code = 'authentication';
  else if (statusCode === 429) code = 'rate_limit';
  else if (statusCode === 400 && /(context|token).*(limit|length|maximum)/i.test(message)) code = 'context_limit';
  else if (statusCode === 400 || statusCode === 404 || statusCode === 422) code = 'invalid_request';
  else if (statusCode !== undefined && statusCode >= 500) code = 'provider_error';
  else if (/(fetch|network|socket|connect|econn|timeout|dns)/i.test(lower)) code = 'network';

  // 认证/参数/上下文错误需要用户修改输入或配置；限流、网络、5xx 才适合直接重试。
  const retryable = code === 'rate_limit' || code === 'network' || code === 'provider_error';
  const base = {code, message, retryable};
  return statusCode === undefined ? base : {...base, statusCode};
}

export function isAdaptiveThinkingUnsupported(error: unknown): boolean {
  // 自动回退必须非常保守：仅明确的 HTTP 400 + adaptive 不支持才匹配。
  const candidate = shape(error);
  const statusValue = candidate.status ?? candidate.statusCode;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return statusValue === 400
    && /adaptive/i.test(message)
    && /(unsupported|not supported|invalid|不支持)/i.test(message);
}
