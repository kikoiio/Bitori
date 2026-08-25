import type {TruncationInfo} from './types.js';
export interface LimitedText {text: string; truncation: TruncationInfo}
export interface LimitedMatches<T> {matches: T[]; truncation: TruncationInfo}

/** [s02] 在 Unicode 码点边界截断，保证返回值仍是有效 UTF-8。 */
export function truncateUtf8(value: string, maximumBytes: number): LimitedText {
  const originalUnits = Buffer.byteLength(value);
  if (maximumBytes < 0) throw new RangeError('maximumBytes 不能为负数');
  if (originalUnits <= maximumBytes) return {text: value, truncation: {truncated: false, originalUnits, returnedUnits: originalUnits, unit: 'bytes'}};
  let text = ''; let returnedUnits = 0;
  for (const character of value) { const size = Buffer.byteLength(character); if (returnedUnits + size > maximumBytes) break; text += character; returnedUnits += size; }
  return {text, truncation: {truncated: true, originalUnits, returnedUnits, unit: 'bytes'}};
}
export function limitMatches<T>(matches: readonly T[], maximumMatches: number): LimitedMatches<T> {
  if (maximumMatches < 0) throw new RangeError('maximumMatches 不能为负数');
  const limited = matches.slice(0, maximumMatches);
  return {matches: limited, truncation: {truncated: limited.length < matches.length, originalUnits: matches.length, returnedUnits: limited.length, unit: 'matches'}};
}
