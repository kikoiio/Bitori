import {Box, Text} from 'ink';

export interface ThinkingBlockProps {content: string; expanded: boolean; streaming: boolean}

/** thinking 为空时完全不占空间；否则显示标题，并按 expanded 决定是否显示正文。 */
export function ThinkingBlock({content, expanded, streaming}: ThinkingBlockProps) {
  if (content.length === 0) return null;
  return <Box flexDirection="column" marginLeft={2}>
    <Text color="gray">{streaming ? '思考中…' : `思考（${expanded ? '已展开' : '已折叠'}）`}</Text>
    {expanded ? <Text color="gray">{content}</Text> : null}
  </Box>;
}
