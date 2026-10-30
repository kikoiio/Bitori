import {Box, Text} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';
import {collapseLabel, foldToolCalls} from '../tool-display.js';
import {ToolCallCard} from './tool-call-card.js';

interface ToolCallListProps {
  records: ToolCallRecord[];
  forceExpanded?: boolean;
}

/** 折叠视图把连续只读调用压成摘要；Ctrl+O 详情模式展开每一项。 */
export function ToolCallList({records, forceExpanded = false}: ToolCallListProps) {
  const items = foldToolCalls(records, forceExpanded);
  return <Box flexDirection="column">
    {items.map((item, index) => item.kind === 'summary'
      ? <Box key={`summary-${item.collapseClass}-${index}`} marginLeft={1}><Text dimColor>{collapseLabel(item.collapseClass, item.count)}</Text></Box>
      : <ToolCallCard key={item.record.id} record={item.record} expanded={forceExpanded} />)}
  </Box>;
}
