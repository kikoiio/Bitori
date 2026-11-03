import {cloudApiRoot} from '../providers/qoder.js';
import {normalizeProviderError, providerErrorGuidance, type ProviderError} from '../providers/errors.js';
import type {ProviderProfile} from '../config/types.js';

export interface RemoteModel {
  id: string;
  displayName?: string;
  enabled: boolean;
}

export interface ProbeResult {
  profileName: string;
  protocol: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  models?: RemoteModel[];
  /** 配置里的 model 是否能在 Provider 列表中找到;无法列表的协议为 undefined。 */
  modelAvailable?: boolean;
  error?: ProviderError;
  guidance?: string;
  note?: string;
}

interface ModelRow {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  label?: unknown;
  description?: unknown;
  is_enabled?: unknown;
  enabled?: unknown;
  status?: unknown;
}

/** 每个协议列出模型的端点;协议没有列表能力时必须显式说明,不伪造。 */
export function modelsEndpoint(profile: ProviderProfile): {url: string; headers: Record<string, string>} | {unsupported: string} {
  const base = profile.baseUrl.trim().replace(/\/+$/, '');
  const auth = {Authorization: `Bearer ${profile.apiKey}`};
  switch (profile.protocol) {
    case 'qoder':
      return {url: `${cloudApiRoot(profile.baseUrl)}/models`, headers: {...auth, Accept: 'application/json'}};
    case 'anthropic':
      // Anthropic 的模型列表在 /v1/models，认证用 x-api-key（官方 SDK 的方式）。
      // 用 Bearer 探测会得到 401，把本来可用的连接误报成失败。
      return {url: `${base}/v1/models`, headers: {'x-api-key': profile.apiKey, Accept: 'application/json', 'anthropic-version': '2023-06-01'}};
    case 'openai-chat':
    case 'openai-responses':
      return {url: `${base}/models`, headers: {...auth, Accept: 'application/json'}};
    default:
      return {unsupported: `协议 ${(profile.protocol as string) ?? '未知'} 不支持模型列表`};
  }
}

function rowToModel(row: ModelRow): RemoteModel | null {
  const id = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : null;
  if (id === null) return null;
  const displayName = typeof row.display_name === 'string' ? row.display_name : typeof row.label === 'string' ? row.label : typeof row.description === 'string' ? row.description : undefined;
  const enabled = row.is_enabled === false || row.enabled === false || row.status === 'deprecated' ? false : true;
  return {id, ...(displayName === undefined ? {} : {displayName}), enabled};
}

function normalizeModelId(value: string): string {
  return value.toLowerCase().replace(/[\s._-]+/g, '');
}

/** 真实网络探测:区分 DNS/超时/401/404/协议不兼容/模型不存在,全程可安全展示(不含密钥)。 */
export async function probeProfile(profile: ProviderProfile, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<ProbeResult> {
  const base: Omit<ProbeResult, 'ok' | 'latencyMs'> = {profileName: profile.name, protocol: profile.protocol, model: profile.model};
  const target = modelsEndpoint(profile);
  if ('unsupported' in target) {
    return {...base, ok: true, latencyMs: 0, note: `${target.unsupported};连接测试退化为最小请求`};
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, {method: 'GET', headers: target.headers, signal: controller.signal});
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      return {...base, latencyMs: Date.now() - started, ok: false, error: {code: 'protocol_mismatch', message: `端点返回了非 JSON 响应(HTTP ${response.status}),base_url 可能不是该协议的接口`, retryable: false}, guidance: providerErrorGuidance('protocol_mismatch')};
    }
    if (!response.ok) {
      const message = extractErrorMessage(payload) ?? `HTTP ${response.status}`;
      const error = normalizeProviderError({status: response.status, message}, profile);
      return {...base, latencyMs: Date.now() - started, ok: false, error, guidance: providerErrorGuidance(error.code)};
    }
    const rows = Array.isArray(payload.data) ? payload.data as ModelRow[] : Array.isArray(payload.models) ? payload.models as ModelRow[] : [];
    const models = rows.map(rowToModel).filter((model): model is RemoteModel => model !== null);
    if (models.length === 0) return {...base, latencyMs: Date.now() - started, ok: true, note: '连接成功,但该端点不提供可用模型列表'};
    const wanted = profile.model.trim();
    const folded = normalizeModelId(wanted);
    const modelAvailable = wanted === '' ? undefined : models.some(model => model.enabled
      && (normalizeModelId(model.id) === folded || normalizeModelId(model.displayName ?? '') === folded));
    const result: ProbeResult = {...base, latencyMs: Date.now() - started, ok: true, models};
    if (modelAvailable !== undefined) {
      result.modelAvailable = modelAvailable;
      if (!modelAvailable) {
        result.guidance = providerErrorGuidance('model_not_found');
        result.note = `配置的模型 “${wanted}” 不在可用列表中`;
      }
    }
    return result;
  } catch (error) {
    const normalized = normalizeProviderError(error, profile);
    const code = normalized.code === 'unknown' ? 'network' : normalized.code;
    return {...base, latencyMs: Date.now() - started, ok: false, error: {...normalized, code}, guidance: providerErrorGuidance(code)};
  } finally {
    clearTimeout(timer);
  }
}

function extractErrorMessage(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return undefined;
}
