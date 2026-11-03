import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export interface QueuedMessagesProps {
  messages: string[];
}

/** 单条排队消息最多显示的字符数：面板高度要可预期，超出部分省略。 */
const previewLimit = 48;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > previewLimit ? `${flat.slice(0, previewLimit)}…` : flat;
}

/** 生成中排队的消息：让用户看见消息已进入队列，而不是被静默丢弃。 */
export function QueuedMessages({messages}: QueuedMessagesProps) {
  if (messages.length === 0) return null;
  return <Box borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
    <Box justifyContent="space-between">
      <Text bold color={theme.accent}>已排队 {messages.length} 条</Text>
      <Text color={theme.faint}>模型在当前回合的下一个步骤读到 · Esc 中断当前生成</Text>
    </Box>
    {messages.map((message, index) => <Text key={`${index}-${preview(message).slice(0, 12)}`} color={theme.text}>· {preview(message)}</Text>)}
  </Box>;
}
