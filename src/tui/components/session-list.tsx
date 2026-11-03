import {Box, Text} from 'ink';
import type {Session} from '../../storage/types.js';
import {theme} from '../theme.js';

export interface SessionListProps {
  sessions: Session[];
  selectedIndex: number;
  /** 搜索过滤前的总数，用于区分“没有会话”和“没匹配到”。 */
  totalCount: number;
  filter?: string;
  renaming?: boolean;
  renameValue?: string;
  deletePending?: Session | null;
}

/** 历史会话面板；↑↓ 选择 · Enter 切换 · 输入即搜索 · r 重命名 · d 删除。 */
export function SessionList({sessions, selectedIndex, totalCount, filter = '', renaming = false, renameValue = '', deletePending = null}: SessionListProps) {
  return <Box borderStyle="round" borderColor={theme.border} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
    <Box justifyContent="space-between">
      <Text bold color={theme.text}>历史会话{filter === '' ? '' : ` · 筛选 “${filter}”`}</Text>
      <Text color={theme.faint}>↑↓ 选择 · Enter 切换 · 输入搜索 · r 重命名 · d 删除</Text>
    </Box>
    {sessions.length === 0 ? <Text color={theme.faint}>{totalCount === 0 ? '暂无会话' : `没有匹配 “${filter}” 的会话`}</Text> : sessions.map((session, index) => {
      const selected = index === selectedIndex;
      return <Box key={session.id}>
        <Text color={selected ? theme.accent : theme.faint}>{selected ? '❯ ' : '  '}</Text>
        <Text bold={selected} color={selected ? theme.text : theme.dim}>{session.title || '新会话'}</Text>
        <Box flexGrow={1} />
        <Text color={theme.faint}>{new Date(session.updatedAt).toLocaleString()}</Text>
      </Box>;
    })}
    {renaming ? <Text color={theme.yellow}>新标题：{renameValue}▏ <Text color={theme.faint}>Enter 确认 · Esc 取消</Text></Text> : null}
    {deletePending !== null ? <Text color={theme.red}>删除「{deletePending.title || '新会话'}」及其全部消息？再按 d 或 Enter 确认 · 其他键取消</Text> : null}
  </Box>;
}
