import {Box, Text} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';
import {callHeadline, editHunk, resultLine} from '../tool-display.js';
import {DiffView} from './diff-view.js';

interface ToolCallCardProps {
  record: ToolCallRecord;
  expanded?: boolean;
}

/** 一行圆点标题 + ⎿ 结果；写操作在折叠视图也内联 diff。 */
export function ToolCallCard({record, expanded = false}: ToolCallCardProps) {
  const color = statusColor(record.executionStatus);
  const headline = callHeadline(record);
  const result = resultLine(record, expanded);
  const hunk = showHunk(record) ? editHunk(record.arguments) : null;
  return <Box flexDirection="column" marginLeft={1}>
    <Text color={color}>● {headline}</Text>
    {result === null ? null : <Text dimColor>  ⎿  {result}</Text>}
    {hunk === null ? null : <Box marginLeft={4}><DiffView oldContent={hunk.oldText} newContent={hunk.newText} maxHeight={expanded ? 24 : 8} /></Box>}
    {expanded ? <VerboseExtras record={record} /> : null}
  </Box>;
}

function showHunk(record: ToolCallRecord): boolean {
  return (record.toolName === 'edit_file' || record.toolName === 'write_file') && record.executionStatus === 'succeeded';
}

function VerboseExtras({record}: {record: ToolCallRecord}) {
  const args = JSON.stringify(record.arguments);
  return <Box flexDirection="column" marginLeft={4}>
    <Text dimColor>参数 {args.length > 240 ? `${args.slice(0, 239)}…` : args}</Text>
    {record.approvalStatus === 'approved' ? <Text dimColor>已批准</Text> : null}
  </Box>;
}

function statusColor(status: ToolCallRecord['executionStatus']): 'green' | 'red' | 'yellow' | 'gray' {
  if (status === 'succeeded') return 'green';
  if (status === 'failed' || status === 'timed_out' || status === 'interrupted') return 'red';
  if (status === 'running' || status === 'queued') return 'yellow';
  return 'gray';
}
