import {Box, Text} from 'ink';
import type {StoredMessage} from '../../storage/types.js';
import {theme} from '../theme.js';
import {Markdown} from './markdown.js';
import {ThinkingBlock} from './thinking-block.js';

export interface MessageProps {message: StoredMessage; selected: boolean; thinkingExpanded: boolean; spinner?: string; gap?: number; width?: number}

/** 用户消息使用整行深色条，助手消息保持无边框排版以贴近 Devin 的阅读体验。 */
export function Message({message, selected, thinkingExpanded, spinner = '●', gap = 1, width = 80}: MessageProps) {
  const content = message.displayContent ?? message.content;
  if (message.role === 'user') {
    return <Box flexDirection="column" marginBottom={gap}>
      <Box backgroundColor={theme.userBar} paddingX={1} width="100%">
        <Text color={selected ? theme.accent : theme.dim}>❯ </Text>
        <Text color={theme.text} wrap="wrap">{content}</Text>
      </Box>
      {message.errorMessage ? <Text color={theme.red}>{message.errorMessage}</Text> : null}
    </Box>;
  }
  const suffix = message.status === 'cancelled' ? ' · 已取消' : message.status === 'failed' ? ' · 失败' : message.status === 'streaming' ? ' · 生成中' : '';
  const suffixColor = message.status === 'failed' ? theme.red : theme.faint;
  return <Box flexDirection="column" marginBottom={gap}>
    <Box>
      <Text color={selected ? theme.accent : theme.faint}>{selected ? '▌' : ' '}</Text>
      <Text color={theme.accent}> ● </Text>
      <Text color={theme.dim}>Bitori</Text>
      {suffix === '' ? null : <Text color={suffixColor}>{suffix}</Text>}
    </Box>
    <Box flexDirection="column" paddingLeft={2}>
      <ThinkingBlock content={message.thinking} expanded={thinkingExpanded || message.status === 'streaming'} streaming={message.status === 'streaming'} />
      {content.length > 0
        ? message.status === 'streaming'
          ? <Text color={theme.text} wrap="wrap">{content}</Text>
          : <Markdown content={content} width={Math.max(24, width - 6)} />
        : message.status === 'streaming' && message.thinking.length === 0 ? <Text color={theme.faint}>{spinner} 正在思考…</Text> : null}
      {message.errorMessage ? <Text color={theme.red}>{message.errorMessage}</Text> : null}
    </Box>
  </Box>;
}
