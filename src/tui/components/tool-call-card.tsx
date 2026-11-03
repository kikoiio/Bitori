import {Box, Text} from 'ink';
import type {LiveToolCall} from '../../chat/state.js';
import type {ToolCallRecord} from '../../storage/types.js';
import {theme} from '../theme.js';
import {callHeadline, displayName, durationLabel, editHunk, previewArguments, resultLines} from '../tool-display.js';
import {DiffView} from './diff-view.js';

interface ToolCallCardProps {
  record: ToolCallRecord;
  expanded?: boolean;
  spinner?: string;
}

/** Devin 风格单行标题 + 输出预览；写操作在折叠视图也内联 diff。 */
export function ToolCallCard({record, expanded = false, spinner = '●'}: ToolCallCardProps) {
  const color = statusColor(record.executionStatus);
  const headline = callHeadline(record);
  const lines = resultLines(record, expanded);
  const hunk = showHunk(record) ? editHunk(record.arguments) : null;
  const duration = durationLabel(record);
  return <Box flexDirection="column" marginLeft={1} marginBottom={1}>
    <Box>
      <Text color={color}>{icon(record.executionStatus, spinner)} </Text>
      <Text bold color={theme.text}>{headline}</Text>
      {duration === null ? null : <Text color={theme.faint}> · {duration}</Text>}
    </Box>
    {lines.map((line, index) => <Text key={`${record.id}-line-${index}`} color={record.executionStatus === 'failed' ? theme.red : theme.dim}>  {line}</Text>)}
    {hunk === null ? null : <Box marginLeft={2} marginTop={1}><DiffView oldContent={hunk.oldText} newContent={hunk.newText} maxHeight={expanded ? 24 : 8} /></Box>}
    {expanded ? <VerboseExtras record={record} /> : null}
  </Box>;
}

/** 工具参数尚未收全时也显示调用名，让用户知道模型正在做什么。 */
export function LiveToolCard({tool, spinner}: {tool: LiveToolCall; spinner: string}) {
  const argument = previewArguments(tool.name, tool.argumentsText);
  return <Box marginLeft={1} marginBottom={0}>
    <Text color={theme.yellow}>{spinner} </Text>
    <Text bold color={theme.text}>{displayName(tool.name)}</Text>
    {argument === null ? <Text color={theme.faint}>…</Text> : <Text color={theme.dim}>({argument})</Text>}
    <Text color={theme.faint}> · 准备中</Text>
  </Box>;
}

function icon(status: ToolCallRecord['executionStatus'], spinner: string): string {
  if (status === 'succeeded') return '✓';
  if (status === 'failed' || status === 'timed_out' || status === 'interrupted') return '✗';
  if (status === 'running' || status === 'queued') return spinner;
  if (status === 'skipped') return '–';
  return '●';
}

function showHunk(record: ToolCallRecord): boolean {
  return (record.toolName === 'edit_file' || record.toolName === 'write_file') && record.executionStatus === 'succeeded';
}

function VerboseExtras({record}: {record: ToolCallRecord}) {
  const args = JSON.stringify(record.arguments);
  return <Box flexDirection="column" marginLeft={2} marginTop={1}>
    <Text color={theme.faint}>参数 {args.length > 240 ? `${args.slice(0, 239)}…` : args}</Text>
    {record.approvalStatus === 'approved' ? <Text color={theme.faint}>已批准</Text> : null}
  </Box>;
}

function statusColor(status: ToolCallRecord['executionStatus']): string {
  if (status === 'succeeded') return theme.green;
  if (status === 'failed' || status === 'timed_out' || status === 'interrupted') return theme.red;
  if (status === 'running' || status === 'queued') return theme.yellow;
  return theme.faint;
}
