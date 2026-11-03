import {Box, Text} from 'ink';
import type {AppState} from '../../chat/state.js';
import {formatUsage} from '../../shared/usage-format.js';
import {theme} from '../theme.js';

const phaseLabels: Record<string, string> = {
  preparing: '准备请求',
  streaming: '正在生成',
  scheduling_tools: '规划工具',
  awaiting_approval: '等待批准',
  executing_tools: '正在执行工具',
  finishing: '收尾',
};

/** 输入框上方的实时活动行：让用户随时知道 Agent 处于什么阶段。 */
export function Activity({state, spinner}: {state: AppState; spinner: string}) {
  const busy = state.requestStatus !== 'idle' && state.requestStatus !== 'failed';
  if (!busy) return null;
  const phase = phaseLabels[state.agentPhase ?? ''] ?? '处理中';
  return <Box justifyContent="space-between" paddingX={1}>
    <Box>
      <Text color={theme.accent}>{spinner} </Text>
      <Text color={theme.dim}>{phase}</Text>
      <Text color={theme.faint}> · 迭代 {state.iteration}/{state.maxIterations} · {formatUsage(state.runUsage)}</Text>
    </Box>
    <Text color={theme.faint}>Ctrl+C 停止</Text>
  </Box>;
}
