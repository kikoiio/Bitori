import type {ProviderProfile} from './types.js';
import {createRedactor, redactedPlaceholder} from '../shared/redact.js';

// [s15] 占位符统一为 shared/redact 的 <redacted>；保留导出兼容既有错误展示调用方。
export const redactedValue = redactedPlaceholder;

/** [s01] 在错误展示前，将所有已加载 profile 的真实 API Key 替换为固定占位符。 */
export function redactSecrets(value: string, profiles: readonly ProviderProfile[]): string {
  // [s15] 委托 shared/redact 的精确串替换实现，避免双份脱敏逻辑。
  return createRedactor(profiles.map(profile => profile.apiKey))(value);
}
