import {Box, Text} from 'ink';
import type {StoredMessage} from '../../storage/types.js';
import {ThinkingBlock} from './thinking-block.js';

export interface MessageProps {message: StoredMessage; selected: boolean; thinkingExpanded: boolean}

/** 渲染单条消息的角色、状态、thinking、正文和错误。 */
export function Message({message, selected, thinkingExpanded}: MessageProps) {
  const label = message.role === 'user' ? '你' : 'Bitori';
  const marker = selected ? '›' : ' ';
  // 嵌套三元表达式把四种状态压缩成可见后缀；completed 对应空字符串。
  const suffix = message.status === 'cancelled' ? ' [已取消]'
    : message.status === 'failed' ? ' [失败]'
      : message.status === 'streaming' ? ' …' : '';
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color={message.role === 'user' ? 'cyan' : 'green'}>{marker} {label}{suffix}</Text>
    {/* 正在流式生成时强制展开 thinking；完成后才遵循用户的展开选择。 */}
    <ThinkingBlock content={message.thinking} expanded={thinkingExpanded || message.status === 'streaming'} streaming={message.status === 'streaming'} />
    {(message.displayContent ?? message.content).length > 0 ? <Text wrap="wrap">{message.displayContent ?? message.content}</Text> : null}
    {message.errorMessage ? <Text color="red">{message.errorMessage}</Text> : null}
  </Box>;
}
