import {Box, Text} from 'ink';
import {homedir} from 'node:os';
import type {AppState} from '../../chat/state.js';
import {theme} from '../theme.js';

const logo = ['▄▄ ▄▄', '██▄██', '▀███▀'];

function workspaceLabel(workspace: string | undefined): string {
  if (!workspace) return 'AI coding agent';
  const home = homedir();
  const shown = workspace === home ? '~' : workspace.startsWith(`${home}/`) ? `~${workspace.slice(home.length)}` : workspace;
  return shown.length > 42 ? `…${shown.slice(-41)}` : shown;
}

/** 品牌头部只展示真实信息：工作区路径、产品名与当前会话。 */
export function Header({state, workspace}: {state: AppState; workspace?: string | undefined}) {
  return <Box paddingX={1}>
    <Box flexDirection="column" marginRight={2}>
      {logo.map((line, index) => <Text key={line} color={index === 1 ? theme.accent : theme.accentSoft}>{line}</Text>)}
    </Box>
    <Box flexDirection="column">
      <Text bold color={theme.text}>Bitori CLI</Text>
      <Text color={theme.faint}>{workspaceLabel(workspace)}</Text>
    </Box>
    <Box flexGrow={1} />
    <Text color={theme.faint}>{state.session?.title ?? '新会话'}</Text>
  </Box>;
}
