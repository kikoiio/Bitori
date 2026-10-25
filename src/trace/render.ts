import {groupByIteration, type TraceIteration} from './reader.js';
import type {ContextCompositionBuckets, TraceEvent} from './types.js';

const bucketLabels: Array<[keyof ContextCompositionBuckets, string]> = [
  ['fixed_system', '系统提示'], ['environment', '环境'], ['custom_instructions', '自定义指令'],
  ['skills', '技能目录'], ['long_term_memory', '长期记忆'], ['tool_definitions', '工具定义'],
  ['user_messages', '用户消息'], ['assistant_messages', '助手消息'], ['tool_results', '工具结果'],
  ['reminders', '提醒'], ['compact_summary', '压缩摘要'],
];

function compositionLine(buckets: ContextCompositionBuckets): string {
  const parts = bucketLabels.filter(([key]) => buckets[key] > 0).map(([key, label]) => `${label} ${buckets[key]}`);
  return parts.join(' · ');
}

function renderIteration(iteration: TraceIteration): string[] {
  const lines: string[] = [];
  lines.push(`── 第 ${iteration.iteration} 轮 ──`);
  if (iteration.request) {
    const request = iteration.request;
    const definitions = request.toolDefinitions.length > 0 ? `${request.toolDefinitions.length} 个定义（全量记录）` : `digest ${request.toolDefinitionDigest}`;
    lines.push(`请求：${request.items.length} 个上下文条目，system ${request.system.length} 块，工具定义 ${definitions}`);
  }
  for (const retry of iteration.retries) {
    lines.push(`重试 #${retry.attempt}：${retry.errorCode}（${retry.errorMessage.slice(0, 80)}），退避 ${retry.delayMs}ms`);
  }
  if (iteration.composition) {
    const composition = iteration.composition;
    lines.push(`组成：估算 ${composition.estimatedTotal} vs 真实 ${composition.providerInputTokens}（差 ${composition.delta}）；${compositionLine(composition.buckets)}`);
  }
  if (iteration.response) {
    const response = iteration.response;
    lines.push(`响应：${response.text.length} 字，耗时 ${response.durationMs}ms，token ${response.usage.inputTokens}↓ ${response.usage.outputTokens}↑${response.usage.cacheReadInputTokens === undefined ? '' : `，缓存读 ${response.usage.cacheReadInputTokens}`}`);
    if (response.errorCode) lines.push(`错误：${response.errorCode}（${response.errorMessage ?? ''}）`);
    for (const call of response.toolCalls) lines.push(`工具 ${call.name}：${call.argumentsText.slice(0, 100)}`);
    if (response.text.length > 0) lines.push(`文本预览：${response.text.slice(0, 200).replaceAll('\n', ' ')}${response.text.length > 200 ? '…' : ''}`);
  }
  return lines;
}

/** [s15] 渲染 trace show 的文本输出；iteration 指定时只渲染该轮。 */
export function renderTraceShow(events: readonly TraceEvent[], options: {iteration?: number} = {}): string {
  const lines: string[] = [];
  const header = events.find((event): event is Extract<TraceEvent, {type: 'run_header'}> => event.type === 'run_header');
  if (header) lines.push(`会话 ${header.sessionId} · profile ${header.profileName} · 模型 ${header.model}（${header.protocol}）· 模式 ${header.mode} · 触发 ${header.trigger}`);
  const domainFacts = events.filter((event): event is Extract<TraceEvent, {type: 'domain_fact'}> => event.type === 'domain_fact');
  for (const fact of domainFacts) lines.push(`事实 ${fact.fact}${fact.data === undefined ? '' : ` ${JSON.stringify(fact.data)}`}`);
  const iterations = groupByIteration(events).filter(iteration => options.iteration === undefined || iteration.iteration === options.iteration);
  if (iterations.length === 0) lines.push(options.iteration === undefined ? '（trace 中没有模型迭代）' : `（没有第 ${options.iteration} 轮）`);
  for (const iteration of iterations) lines.push(...renderIteration(iteration));
  return lines.join('\n');
}

/** [s15] 渲染逐轮 token 曲线（文本表格）。 */
export function renderTokenTrend(events: readonly TraceEvent[]): string {
  const lines: string[] = ['轮次  估算  真实  差值  输出↑'];
  for (const iteration of groupByIteration(events)) {
    if (!iteration.composition && !iteration.response) continue;
    const estimated = iteration.composition?.estimatedTotal ?? '-';
    const real = iteration.composition?.providerInputTokens ?? '-';
    const delta = iteration.composition?.delta ?? '-';
    const output = iteration.response?.usage.outputTokens ?? '-';
    lines.push(`${String(iteration.iteration).padStart(4)}  ${String(estimated).padStart(5)}  ${String(real).padStart(5)}  ${String(delta).padStart(5)}  ${String(output).padStart(5)}`);
  }
  return lines.join('\n');
}
