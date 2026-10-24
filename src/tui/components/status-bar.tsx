import {Box, Text} from 'ink';
import type {AppState} from '../../chat/state.js';

/** [s01] 顶部状态栏：profile/model/请求状态来自同一个 AppState 快照。 */
export function StatusBar({state}: {state: AppState}) {
  // [s01] 供应商没有上报 usage 时保持空白，项目不会自行估算 token。
  const displayedUsage = state.runUsage.inputTokens || state.runUsage.outputTokens || state.latestUsage === null ? state.runUsage : state.latestUsage;
  // [s04] 缓存命中来自 Anthropic usage 事件，不持久化；命中数大于 0 时才展示。
  const cache = (displayedUsage.cacheReadInputTokens ?? 0) > 0 ? ` · cache ${displayedUsage.cacheReadInputTokens}` : '';
  const usage = `  tokens ${displayedUsage.inputTokens}↓ ${displayedUsage.outputTokens}↑${cache}`;
  const progress = state.activeRunId === null ? '' : ` · ${state.iteration}/${state.maxIterations}${state.agentPhase ? ` · ${state.agentPhase}` : ''}`;
  const permission = state.permissionTier === 'strict' ? '严格' : state.permissionTier === 'bypass' ? '放行' : '默认';
  return <Box justifyContent="space-between">
    <Text inverse> Bitori </Text>
    <Text>{state.profile?.name ?? '-'} · {state.profile?.model ?? '-'} · {state.agentMode === 'plan' ? 'PLAN' : 'DO'} · {state.requestStatus} · 权限:{permission}{progress}{usage}</Text>
    <Text color="gray">Ctrl+N 新建 · Ctrl+O 历史</Text>
  </Box>;
}
