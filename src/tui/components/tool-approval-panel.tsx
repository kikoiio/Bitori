import {Box, Text} from 'ink';
import type {ToolApprovalPrompt} from '../../tools/types.js';
import {displayName, editHunk, primaryArgument} from '../tool-display.js';
import {DiffView} from './diff-view.js';

/** 人在回路：编号选项 + Y/S/P/N；编辑类审批复用同一套 diff。 */
export function ToolApprovalPanel({prompt}: {prompt: ToolApprovalPrompt}) {
  const args = parseArguments(prompt.argumentSummary);
  const hunk = args === null ? null : editHunk(args);
  const target = args === null ? null : primaryArgument(prompt.toolName, args);
  const title = prompt.effect === 'write' ? `编辑文件${target === null ? '' : ` ${target}`}` : prompt.effect === 'command' ? '命令' : displayName(prompt.toolName);
  return <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
    <Text bold>{title}</Text>
    {prompt.reason ? <Text color="yellow">{prompt.reason}</Text> : null}
    {hunk === null ? <Text>{commandPreview(prompt)}</Text> : <DiffView oldContent={hunk.oldText} newContent={hunk.newText} maxHeight={12} />}
    {prompt.riskMessage ? <Text color="yellow">{prompt.riskMessage}</Text> : null}
    <Text dimColor>是否继续？</Text>
    <Text>❯ 1. 是</Text>
    <Text>  2. 是，本会话允许</Text>
    <Text>  3. 是，永久允许</Text>
    <Text>  4. 否</Text>
    <Text>Y 批准(本次) / S 本会话 / P 永久 / N 拒绝 / Ctrl+C 取消</Text>
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
