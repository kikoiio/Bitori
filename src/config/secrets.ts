import type {ProviderProfile} from './types.js';

export const redactedValue = '[REDACTED]';

/** [s01] 在错误展示前，将所有已加载 profile 的真实 API Key 替换为固定占位符。 */
export function redactSecrets(value: string, profiles: readonly ProviderProfile[]): string {
  // [s01] reduce 让前一个 profile 的脱敏结果继续交给下一个 profile 处理。
  return profiles.reduce((result, profile) => {
    if (profile.apiKey.length === 0) return result;
    return result.replaceAll(profile.apiKey, redactedValue);
  }, value);
}
