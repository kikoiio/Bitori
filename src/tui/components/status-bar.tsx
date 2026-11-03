import {Box, Text} from 'ink';
import type {AppState} from '../../chat/state.js';
import {formatUsage} from '../../shared/usage-format.js';
import {theme} from '../theme.js';

function statusColor(status: AppState['requestStatus']): string {
  if (status === 'failed') return theme.red;
  if (status === 'idle') return theme.dim;
  if (status === 'cancelling') return theme.yellow;
  return theme.accent;
}

/** 顶部信息行：profile/model/模式/请求状态/权限与用量。 */
export function StatusBar({state}: {state: AppState}) {
  const displayedUsage = state.runUsage.inputTokens || state.runUsage.outputTokens || state.runUsage.credits || state.latestUsage === null ? state.runUsage : state.latestUsage;
  const usage = formatUsage(displayedUsage);
  const permission = state.permissionTier === 'strict' ? '严格' : state.permissionTier === 'bypass' ? '放行' : '默认';
  const mode = state.agentMode === 'plan' ? 'PLAN' : 'DO';
  return <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
    <Box>
      <Text color={statusColor(state.requestStatus)}>● </Text>
      <Text color={theme.dim}>{state.profile?.name ?? '-'} · {state.profile?.model ?? '-'} · {mode} · {state.requestStatus}</Text>
      <Text color={theme.faint}> · 权限:{permission} · {usage}</Text>
    </Box>
    <Text color={theme.faint}>/ 命令 · ^N 新建 · ^S 会话</Text>
  </Box>;
}
