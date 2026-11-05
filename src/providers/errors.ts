import type {ProviderProfile} from '../config/types.js';
import {redactSecrets} from '../config/secrets.js';

export type ProviderErrorCode =
  | 'authentication'
  | 'rate_limit'
  | 'network'
  | 'context_limit'
  | 'invalid_request'
  | 'provider_error'
  | 'session_busy'
  | 'model_not_found'
  | 'unsupported_action'
  | 'protocol_mismatch'
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
  providerCode?: unknown;
}

function shape(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? error : {};
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  const candidate = shape(error);
  return signal?.aborted === true || candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

const isSessionBusyMessage = /currently processing a turn|session.*busy/i;
const isModelMissingMessage = /available model|model.*(not found|doesn't exist|does not exist|unsupported)|unknown model/i;

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

  let code: ProviderErrorCode;
  if (typeof candidate.providerCode === 'string') code = candidate.providerCode as ProviderErrorCode;
  else if (statusCode === 423 || (statusCode === 409 && isSessionBusyMessage.test(message))) code = 'session_busy';
  else if ((statusCode === 400 || statusCode === 404 || statusCode === 422) && isModelMissingMessage.test(message)) code = 'model_not_found';
  else if (statusCode === 409) code = 'provider_error';
  else if (statusCode === 401 || statusCode === 403) code = 'authentication';
  else if (statusCode === 429) code = 'rate_limit';
  else if (statusCode === 400 && /(context|token).*(limit|length|maximum)/i.test(message)) code = 'context_limit';
  else if (statusCode === 400 || statusCode === 404 || statusCode === 422) code = 'invalid_request';
  else if (statusCode !== undefined && statusCode >= 500) code = 'provider_error';
  else if (/(fetch|network|socket|connect|econn|timeout|dns)/i.test(lower)) code = 'network';
  else if (isSessionBusyMessage.test(message)) code = 'session_busy';
  else code = 'unknown';

  // 认证/参数/上下文/模型/busy 需要用户改配置或等待;限流、网络、5xx 才适合直接重试。
  const retryable = code === 'rate_limit' || code === 'network' || code === 'provider_error';
  const base = {code, message, retryable};
  return statusCode === undefined ? base : {...base, statusCode};
}

/** UI 展示失败时的下一步动作;不出现无说明的停止原因。 */
export function providerErrorGuidance(code: ProviderErrorCode): string {
  switch (code) {
    case 'authentication': return '请检查 API Key 是否正确或已过期;可运行 bitori doctor 验证连接。';
    case 'model_not_found': return '模型 id 不存在或未启用;运行 bitori doctor 查看可用模型,或用 /model 更换。';
    case 'network': return '网络/DNS/超时失败;检查网络连接或代理后重试。';
    case 'rate_limit': return '触发限流;稍后重试,或检查账户配额。';
    case 'context_limit': return '上下文超出模型窗口;使用 /compact 压缩后重试。';
    case 'invalid_request': return '请求被服务端拒绝;检查 profile 的 model/base_url/参数配置。';
    case 'provider_error': return '服务端错误;稍后自动重试,持续失败时查看 trace。';
    case 'session_busy': return '上一轮仍在服务端处理;下一条消息会自动切换新会话,或先取消当前任务。';
    case 'unsupported_action': return '服务端要求处理 Bitori 无法承接的内置工具动作;请反馈该会话日志。';
    case 'protocol_mismatch': return '接口地址与协议不匹配;确认 profile.protocol 与 base_url 指向同一类端点。';
    default: return '未知供应商错误;打开调试面板或 trace 查看完整原因。';
  }
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
