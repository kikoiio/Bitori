import {Box, Text} from 'ink';
import type {ToolCallRecord} from '../../storage/types.js';
import {theme} from '../theme.js';
import {sessionHunks} from '../tool-display.js';
import {DiffView} from './diff-view.js';

interface DiffPanelProps {
  records: readonly ToolCallRecord[];
  width: number;
}

/** 右侧伴随式改动侧栏，数据来自本会话已成功的 Write/Update。 */
export function DiffPanel({records, width}: DiffPanelProps) {
  const hunks = sessionHunks(records);
  return <Box width={width} flexDirection="column" borderStyle="round" borderColor={theme.border} backgroundColor={theme.panel} paddingX={1}>
    <Box justifyContent="space-between">
      <Text color={theme.dim}>改动 · 本次会话</Text>
      <Text color={theme.faint}>✕</Text>
    </Box>
    {hunks.length === 0
      ? <Box flexGrow={1} justifyContent="center" alignItems="center"><Text color={theme.faint}>本次没有改动</Text></Box>
      : <Box flexDirection="column">{hunks.map((hunk, index) => <Box key={`${hunk.path}-${index}`} flexDirection="column" marginBottom={1}>
        <DiffView oldContent={hunk.oldText} newContent={hunk.newText} filename={hunk.path} maxHeight={16} />
      </Box>)}</Box>}
    <Text color={theme.faint}>Esc 关闭 · /diff 切换</Text>
  </Box>;
}
