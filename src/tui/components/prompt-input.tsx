import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export interface PromptInputProps {
  value: string;
  focused: boolean;
  disabled: boolean;
  width?: number;
  model?: string;
  mode?: string;
  permission?: string;
}

/** Devin 风格输入区：顶部细横线、橙色 ❯、底栏展示模型/模式/快捷键。 */
export function PromptInput({value, focused, disabled, width = 80, model = '-', mode = 'DO', permission = '默认'}: PromptInputProps) {
  const placeholder = disabled ? '请等待当前回复完成…' : '描述任务，或向 Bitori 提问';
  const lines = value.split('\n');
  const visible = lines.slice(-3).join('\n');
  return <Box flexDirection="column" paddingX={1}>
    <Text color={theme.borderSoft}>{'─'.repeat(Math.max(12, width - 4))}</Text>
    <Box minHeight={1}>
      <Text bold color={theme.accent}>❯ </Text>
      {visible.length > 0 ? <Text color={theme.text} wrap="wrap">{visible}</Text> : <Text color={theme.faint}>{placeholder}</Text>}
      {focused && !disabled ? <Text color={theme.accent}>▌</Text> : null}
    </Box>
    <Box justifyContent="space-between">
      <Text color={theme.faint}>{model} · {mode} · 权限 {permission}</Text>
      <Text color={theme.faint}>/ 命令 · Enter 发送 · Ctrl+O 工具详情 · Ctrl+/- 页面</Text>
    </Box>
  </Box>;
}
