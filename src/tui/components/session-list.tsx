import {Box, Text} from 'ink';
import type {Session} from '../../storage/types.js';

export interface SessionListProps {sessions: Session[]; selectedIndex: number}

/** 绝对定位在聊天页上方的历史会话选择浮层。 */
export function SessionList({sessions, selectedIndex}: SessionListProps) {
  return <Box position="absolute" flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} width="80%">
    <Text bold>历史会话</Text>
    {sessions.length === 0 ? <Text color="gray">暂无会话</Text> : sessions.map((session, index) =>
      <Text key={session.id} inverse={index === selectedIndex}>
        {/* updatedAt 在数据库中是毫秒时间戳，这里按用户系统区域格式显示。 */}
        {index === selectedIndex ? '› ' : '  '}{session.title}  {new Date(session.updatedAt).toLocaleString()}
      </Text>)}
    <Text color="gray">↑/↓ 选择 · Enter 切换 · Esc 关闭</Text>
  </Box>;
}
