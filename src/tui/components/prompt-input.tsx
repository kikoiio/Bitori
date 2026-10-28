import {Box, Text} from 'ink';

export interface PromptInputProps {value: string; focused: boolean; disabled: boolean}

/** 受控输入框：真实文本保存在父组件 draft 中，本组件只负责展示。 */
export function PromptInput({value, focused, disabled}: PromptInputProps) {
  return <Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} minHeight={3}>
    <Text {...(disabled ? {color: 'gray' as const} : {})}>{focused ? '› ' : '  '}{value || (disabled ? '请等待当前回复完成' : '输入消息，Enter 发送')}</Text>
  </Box>;
}
