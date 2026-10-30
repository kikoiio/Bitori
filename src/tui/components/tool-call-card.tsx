import {Box, Text} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';

interface ToolCallCardProps {
  record: ToolCallRecord;
  expanded?: boolean;
  onToggle?: () => void;
  streamingOutput?: string;
}

/** 工具卡片显示稳定名称、关键参数、审批和执行终态。支持展开/折叠和流式输出。 */
export function ToolCallCard({record, expanded = false, onToggle, streamingOutput}: ToolCallCardProps) {
  const color = record.executionStatus === 'succeeded' ? 'green' : record.executionStatus === 'failed' || record.executionStatus === 'timed_out' || record.executionStatus === 'interrupted' ? 'red' : 'yellow';
  const statusIcon = record.executionStatus === 'running' ? '⟳' : record.executionStatus === 'succeeded' ? '✓' : record.executionStatus === 'failed' ? '✗' : '⚙';
  
  // 格式化参数（摘要）
  const argsSummary = JSON.stringify(record.arguments).slice(0, 160);
  
  // 格式化输出（如果有）
  const output = streamingOutput || (record.result ? JSON.stringify(record.result).slice(0, 200) : '');
  const outputPreview = output ? output.slice(0, 200) : '';

  return (
    <Box flexDirection="column" marginLeft={2} borderStyle="single" borderColor={color} paddingX={1}>
      <Box>
        <Text color={color}>{statusIcon} {record.toolName}</Text>
        <Text dimColor> · {record.approvalStatus} · {record.executionStatus}</Text>
        {onToggle && <Text dimColor> [↕ 展开]</Text>}
      </Box>
      <Text dimColor>参数: {argsSummary}</Text>
      {expanded && outputPreview && (
        <Box flexDirection="column">
          <Text dimColor>输出:</Text>
          <Text dimColor>{outputPreview}</Text>
        </Box>
      )}
    </Box>
  );
}
