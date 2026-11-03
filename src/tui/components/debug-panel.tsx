import {Box, Text} from 'ink';
import type {ChatController} from '../../chat/agent-controller.js';
import type {AppState} from '../../chat/state.js';
import {formatUsage} from '../../shared/usage-format.js';
import {theme} from '../theme.js';

export interface DebugPanelProps {state: AppState; controller: ChatController; height: number}

/** Ctrl+T 调试面板：实时事件流、当前迭代与阶段、用量与已激活技能。 */
export function DebugPanel({state, controller, height}: DebugPanelProps) {
  const entries = controller.debugEntries(Math.max(4, height - 6));
  const lines: string[] = [];
  lines.push(`迭代 ${state.iteration}/${state.maxIterations} · 阶段 ${state.agentPhase ?? '-'} · 模式 ${state.agentMode}`);
  lines.push(`本轮用量 · ${formatUsage(state.latestUsage)}`);
  lines.push(`累计用量 · ${formatUsage(state.runUsage)}`);
  const skills = controller.activeSkills();
  lines.push(`已激活技能：${skills.length === 0 ? '（无）' : skills.join(', ')}`);
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.border} backgroundColor={theme.panel} height={Math.min(height, 6 + entries.length)} paddingX={1} marginX={1} marginBottom={1}>
    <Text bold color={theme.accent}>调试面板（Ctrl+T 关闭）</Text>
    {lines.map(line => <Text key={line} color={theme.faint}>{line}</Text>)}
    {entries.map(entry => <Text key={`${entry.at}-${entry.text}`} color={theme.dim}>· {entry.text}</Text>)}
  </Box>;
}
