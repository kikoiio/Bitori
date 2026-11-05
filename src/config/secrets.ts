import type {ProviderProfile} from './types.js';
import {createRedactor} from '../shared/redact.js';

/** 在错误展示前，将所有已加载 profile 的真实 API Key 替换为固定占位符。 */
export function redactSecrets(value: string, profiles: readonly ProviderProfile[]): string {
  return createRedactor(profiles.map(profile => profile.apiKey))(value);
}
