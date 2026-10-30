import {Box, Text} from 'ink';
import type {StoredMessage} from '../../storage/types.js';
import {Message} from './message.js';
import type {ToolCallRecord} from '../../storage/types.js';
import {ToolCallList} from './tool-call-list.js';

export interface MessageListProps {
  messages: StoredMessage[];
  height: number;
  offset: number;
  selectedMessageId: string | null;
  expandedThinkingIds: Set<string>;
  toolCalls?: ToolCallRecord[];
  toolCallsExpanded?: boolean;
}

export function MessageList({messages, height, offset, selectedMessageId, expandedThinkingIds, toolCalls = [], toolCallsExpanded = false}: MessageListProps) {
  if (messages.length === 0) return <Box height={height} justifyContent="center" alignItems="center"><Text color="gray">开始一段新对话</Text></Box>;
  // 这是简单的“按条数”窗口化：粗略假定一条消息平均占 3 行，避免把全部历史交给终端渲染。
  const visibleCount = Math.max(1, Math.floor(height / 3));
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - visibleCount);
  return <Box flexDirection="column" height={height} overflow="hidden">
    {messages.slice(start, end).map(message => <Box key={message.id} flexDirection="column"><Message message={message}
      selected={message.id === selectedMessageId} thinkingExpanded={expandedThinkingIds.has(message.id)} /><ToolCallList records={toolCalls.filter(record => record.assistantMessageId === message.id)} forceExpanded={toolCallsExpanded} /></Box>)}
  </Box>;
}
