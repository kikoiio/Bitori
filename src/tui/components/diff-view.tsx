import {Box, Text} from 'ink';

interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  lineNumber?: number;
}

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filename?: string;
  maxHeight?: number;
}

/** 简单的 unified diff 视图，显示文件修改。 */
export function DiffView({oldContent, newContent, filename, maxHeight = 20}: DiffViewProps) {
  const lines = computeDiff(oldContent, newContent);
  const visibleLines = lines.slice(0, maxHeight);
  
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
      {filename && <Box><Text bold color="blue">📄 {filename}</Text></Box>}
      <Box flexDirection="column">
        {visibleLines.map((line, index) => {
          const color = line.type === 'add' ? 'green' : line.type === 'remove' ? 'red' : 'gray';
          const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
          return (
            <Box key={index}>
              <Text color={color}>{prefix} {line.content}</Text>
            </Box>
          );
        })}
        {lines.length > maxHeight && (
          <Text dimColor>... 还有 {lines.length - maxHeight} 行未显示</Text>
        )}
      </Box>
    </Box>
  );
}

/** 简单的逐行 diff 计算（简化版，实际应使用 diff 库）。 */
function computeDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: DiffLine[] = [];
  
  // 简化实现：逐行比较
  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === newLine) {
      if (oldLine !== undefined) {
        result.push({type: 'context', content: oldLine});
      }
    } else {
      if (oldLine !== undefined) {
        result.push({type: 'remove', content: oldLine});
      }
      if (newLine !== undefined) {
        result.push({type: 'add', content: newLine});
      }
    }
  }
  
  return result;
}
