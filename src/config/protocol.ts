import {protocols, type Protocol} from './types.js';

/**
 * 协议判定结果。结论必须带依据：地址或密钥形状明确时是 strong，
 * 兜底时是 weak，用户一眼能看出是不是猜的。
 */
export interface ProtocolGuess {
  protocol: Protocol;
  /** 判定依据的简短说明。 */
  reason: string;
  /** strong=形状明确；weak=按最常见方言兜底。 */
  confidence: 'strong' | 'weak';
  /** 其它可能的方言，供人工核对。 */
  alternatives: Protocol[];
}

/**
 * 从连接参数推断接口方言。
 *
 * 市场上真正流通的通用方言只有三种：Anthropic Messages、OpenAI Chat Completions、
 * OpenAI Responses；Qoder Cloud Agents 是厂商私有协议，靠 PAT(pt-) 前缀和地址就能认出来。
 *
 * 判定顺序按信号强度：密钥形状 > 地址路径关键词 > 常见兜底。
 * 兜底选 openai-chat——绝大多数自建网关与第三方平台都只提供它。
 * 拿不准时不要猜得更玄：把依据和备选一起交给用户，config.yaml 里写死即可覆盖。
 */
export function inferProtocol(input: {baseUrl?: string; apiKey?: string}): ProtocolGuess {
  const baseUrl = (input.baseUrl ?? '').trim().toLowerCase();
  const apiKey = (input.apiKey ?? '').trim();

  if (apiKey.startsWith('pt-')) {
    return {protocol: 'qoder', reason: '密钥是 Qoder PAT(pt-) 形状', confidence: 'strong', alternatives: []};
  }
  if (baseUrl.includes('qoder')) {
    return {protocol: 'qoder', reason: '地址里含 qoder', confidence: 'strong', alternatives: []};
  }
  if (baseUrl.includes('anthropic') || baseUrl.includes('claude')) {
    return {protocol: 'anthropic', reason: '地址里含 anthropic/claude', confidence: 'strong', alternatives: ['openai-chat']};
  }
  if (baseUrl.includes('/responses')) {
    return {protocol: 'openai-responses', reason: '地址里含 /responses', confidence: 'strong', alternatives: ['openai-chat']};
  }
  if (baseUrl.includes('chat/completions')) {
    return {protocol: 'openai-chat', reason: '地址里含 chat/completions', confidence: 'strong', alternatives: ['anthropic']};
  }
  return {
    protocol: 'openai-chat',
    reason: '地址看不出方言，按最常见的 OpenAI 兼容接口处理',
    confidence: 'weak',
    alternatives: protocols.filter(protocol => protocol !== 'openai-chat'),
  };
}

/** 把 .env 里的 `<前缀>_PROTOCOL` 读成协议；缺失或非法都返回 undefined，由推断接手。 */
export function parseProtocolHint(value: string | undefined): Protocol | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return (protocols as readonly string[]).includes(normalized) ? normalized as Protocol : undefined;
}
