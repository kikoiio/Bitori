import {Box, Text} from 'ink';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';

export interface DebugPanelProps {state: AppState; controller: ChatController; height: number}

function usageLine(label: string, usage: {inputTokens: number; outputTokens: number; cacheReadInputTokens?: number}): string {
  const cache = usage.cacheReadInputTokens === undefined ? '' : ` 缓存读 ${usage.cacheReadInputTokens}`;
  return `${label} ${usage.inputTokens}↓ ${usage.outputTokens}↑${cache}`;
}

/** Ctrl+T 调试面板：实时事件流、当前迭代与阶段、用量与已激活技能。 */
export function DebugPanel({state, controller, height}: DebugPanelProps) {
  const entries = controller.debugEntries(Math.max(4, height - 6));
  const lines: string[] = [];
  lines.push(`迭代 ${state.iteration}/${state.maxIterations} · 阶段 ${state.agentPhase ?? '-'} · 模式 ${state.agentMode}`);
  lines.push(usageLine('本轮用量', state.latestUsage ?? {inputTokens: 0, outputTokens: 0}));
  lines.push(usageLine('累计用量', state.runUsage));
  const skills = controller.activeSkills();
  lines.push(`已激活技能：${skills.length === 0 ? '（无）' : skills.join(', ')}`);
  return <Box flexDirection="column" borderStyle="round" borderColor="gray" height={Math.min(height, 6 + entries.length)} paddingX={1}>
    <Text bold color="cyan">调试面板（Ctrl+T 关闭）</Text>
    {lines.map(line => <Text key={line} dimColor>{line}</Text>)}
    {entries.map(entry => <Text key={`${entry.at}-${entry.text}`}>· {entry.text}</Text>)}
  </Box>;
}
