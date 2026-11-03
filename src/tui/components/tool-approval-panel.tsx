import {Box, Text} from 'ink';
import type {ToolApprovalPrompt} from '../../tools/types.js';
import {theme} from '../theme.js';
import {displayName, editHunk, primaryArgument} from '../tool-display.js';
import {DiffView} from './diff-view.js';

const options = ['是', '是，本会话允许', '是，永久允许', '否'] as const;

/** 人在回路：↑↓ 选择 + Enter 确认，同时保留 Y/S/P/N 与数字快捷键。 */
export function ToolApprovalPanel({prompt, selectedIndex = 0}: {prompt: ToolApprovalPrompt; selectedIndex?: number}) {
  const args = parseArguments(prompt.argumentSummary);
  const hunk = args === null ? null : editHunk(args);
  const target = args === null ? null : primaryArgument(prompt.toolName, args);
  const title = prompt.effect === 'write' ? `编辑文件${target === null ? '' : ` ${target}`}` : prompt.effect === 'command' ? '命令' : displayName(prompt.toolName);
  return <Box borderStyle="round" borderColor={theme.yellow} backgroundColor={theme.panel} flexDirection="column" paddingX={1} marginX={1} marginBottom={1}>
    <Box justifyContent="space-between">
      <Text bold color={theme.text}>{title}</Text>
      <Text color={theme.yellow}>需要你的批准</Text>
    </Box>
    {prompt.reason ? <Text color={theme.yellow}>{prompt.reason}</Text> : null}
    {hunk === null ? <Text color={theme.text}>{commandPreview(prompt)}</Text> : <DiffView oldContent={hunk.oldText} newContent={hunk.newText} maxHeight={12} />}
    {prompt.riskMessage ? <Text color={theme.yellow}>{prompt.riskMessage}</Text> : null}
    <Text color={theme.dim}>是否继续？</Text>
    {options.map((label, index) => {
      const selected = index === selectedIndex;
      return <Text key={label} color={selected ? theme.text : theme.dim}>
        {selected ? '❯ ' : '  '}{index + 1}. {label}
      </Text>;
    })}
    <Text color={theme.faint}>↑↓ 选择 · Enter 确认 · Y 批准(本次) / S 本会话 / P 永久 / N 拒绝 · Ctrl+C 取消</Text>
  </Box>;
}

function parseArguments(summary: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(summary);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function commandPreview(prompt: ToolApprovalPrompt): string {
  const args = parseArguments(prompt.argumentSummary);
  if (args !== null) {
    const primary = primaryArgument(prompt.toolName, args);
    if (primary !== null) return primary;
  }
  return prompt.argumentSummary;
}
