import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export interface PaletteCommand {
  name: string;
  description: string;
  aliases?: string[];
  argumentHint?: string;
}

interface SlashMenuProps {
  commands: PaletteCommand[];
  selectedIndex: number;
}

const maxVisible = 6;

/** 输入 `/` 后出现的命令面板，行为对齐 Devin/Claude 的斜杠菜单。 */
export function SlashMenu({commands, selectedIndex}: SlashMenuProps) {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), commands.length - maxVisible));
  const visible = commands.slice(start, start + maxVisible);
  return <Box borderStyle="round" borderColor={theme.border} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
    <Box justifyContent="space-between">
      <Text color={theme.dim}>命令</Text>
      <Text color={theme.faint}>↑↓ 选择 · Tab 补全 · Enter 运行 · Esc 关闭</Text>
    </Box>
    {commands.length === 0 ? <Text color={theme.faint}>没有匹配的命令</Text> : visible.map((command, offset) => {
      const index = start + offset;
      const selected = index === selectedIndex;
      return <Box key={command.name}>
        <Text color={selected ? theme.accent : theme.faint}>{selected ? '❯ ' : '  '}</Text>
        <Text bold={selected} color={selected ? theme.text : theme.dim}>/{command.name}</Text>
        {command.argumentHint === undefined ? null : <Text color={theme.faint}> {command.argumentHint}</Text>}
        <Box flexGrow={1} />
        <Text color={theme.faint}>{command.description}</Text>
      </Box>;
    })}
    {start > 0 ? <Text color={theme.faint}>↑ 还有 {start} 个命令</Text> : null}
  </Box>;
}
