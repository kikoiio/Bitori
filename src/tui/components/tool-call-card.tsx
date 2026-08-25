import {Box, Text} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';

/** [s02] 工具卡片显示稳定名称、关键参数、审批和执行终态。 */
export function ToolCallCard({record}: {record: ToolCallRecord}) {
  const color = record.executionStatus === 'succeeded' ? 'green' : record.executionStatus === 'failed' || record.executionStatus === 'timed_out' || record.executionStatus === 'interrupted' ? 'red' : 'yellow';
  return <Box flexDirection="column" marginLeft={2}><Text color={color}>⚙ {record.toolName} · {record.approvalStatus} · {record.executionStatus}</Text><Text dimColor>{JSON.stringify(record.arguments).slice(0, 160)}</Text></Box>;
}
