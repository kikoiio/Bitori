import type {Usage} from '../providers/types.js';

/**
 * 用量展示的唯一入口：Qoder 只上报 credits 时不得显示成 "tokens 0↓ 0↑"，
 * 两个来源都缺失时显示 `-` 而不是伪造数字。
 */
export function formatUsage(usage: Usage | null): string {
  if (!usage) return 'tokens —';
  const credits = usage.credits === undefined || usage.credits === 0 ? '' : `credits ${trimCredits(usage.credits)}`;
  const hasTokens = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (!hasTokens) return credits || 'tokens —';
  const cache = (usage.cacheReadInputTokens ?? 0) > 0 ? ` · cache ${usage.cacheReadInputTokens}` : '';
  const tokens = `tokens ${usage.inputTokens}↓ ${usage.outputTokens}↑${cache}`;
  return credits ? `${tokens} · ${credits}` : tokens;
}

function trimCredits(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}
