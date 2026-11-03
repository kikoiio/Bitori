import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export interface ThinkingBlockProps {content: string; expanded: boolean; streaming: boolean}

/** thinking 为空时完全不占空间；否则显示一行摘要，展开后显示正文。 */
export function ThinkingBlock({content, expanded, streaming}: ThinkingBlockProps) {
  if (content.length === 0) return null;
  return <Box flexDirection="column" marginLeft={2}>
    <Text color={theme.faint}>{expanded ? '▾' : '▸'} {streaming ? '正在思考…' : `思考过程 · ${content.length} 字`}</Text>
    {expanded ? <Box marginTop={0}><Text color={theme.dim} wrap="wrap">{content}</Text></Box> : null}
  </Box>;
}
