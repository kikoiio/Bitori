import {Box, Text} from 'ink';
import type {LiveToolCall} from '../../chat/state.js';
import type {ToolCallRecord} from '../../storage/types.js';
import {theme} from '../theme.js';
import {collapseLabel, foldToolCalls} from '../tool-display.js';
import {LiveToolCard, ToolCallCard} from './tool-call-card.js';

interface ToolCallListProps {
  records: ToolCallRecord[];
  forceExpanded?: boolean;
  spinner?: string;
}

/** 折叠视图把连续只读调用压成摘要；Ctrl+O 详情模式展开每一项。 */
export function ToolCallList({records, forceExpanded = false, spinner = '●'}: ToolCallListProps) {
  const items = foldToolCalls(records, forceExpanded);
  return <Box flexDirection="column">
    {items.map((item, index) => item.kind === 'summary'
      ? <Box key={`summary-${item.collapseClass}-${index}`} marginLeft={1} marginBottom={1}><Text color={theme.faint}>◦ {collapseLabel(item.collapseClass, item.count)}</Text></Box>
      : <ToolCallCard key={item.record.id} record={item.record} expanded={forceExpanded} spinner={spinner} />)}
  </Box>;
}

export function LiveToolList({tools, spinner}: {tools: LiveToolCall[]; spinner: string}) {
  if (tools.length === 0) return null;
  return <Box flexDirection="column" marginTop={1}>
    {tools.map(tool => <LiveToolCard key={tool.callId} tool={tool} spinner={spinner} />)}
  </Box>;
}
