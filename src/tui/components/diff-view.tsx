import {Box, Text} from 'ink';
import {diffLines, diffWords, formatLineNumber, gutterWidth, type LineChange} from '../diff.js';

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filename?: string;
  maxHeight?: number;
}

/** 双行号 gutter 的行级 diff；成对替换行再做词级高亮。 */
export function DiffView({oldContent, newContent, filename, maxHeight = 20}: DiffViewProps) {
  const changes = diffLines(oldContent, newContent);
  const width = gutterWidth(changes);
  const visible = changes.slice(0, maxHeight);
  const pairs = pairReplacements(visible);
  return <Box flexDirection="column">
    {filename ? <Text bold color="blue">{filename}</Text> : null}
    {pairs.map((pair, index) => <DiffPair key={index} pair={pair} width={width} />)}
    {changes.length > maxHeight ? <Text dimColor>… 还有 {changes.length - maxHeight} 行未显示</Text> : null}
  </Box>;
}

type RenderPair =
  | {kind: 'line'; change: LineChange}
  | {kind: 'replace'; removed: LineChange; added: LineChange};

function pairReplacements(changes: readonly LineChange[]): RenderPair[] {
  const pairs: RenderPair[] = [];
  for (let index = 0; index < changes.length; index++) {
    const current = changes[index]!;
    const next = changes[index + 1];
    if (current.kind === 'remove' && next?.kind === 'add') {
      pairs.push({kind: 'replace', removed: current, added: next});
      index += 1;
    } else {
      pairs.push({kind: 'line', change: current});
    }
  }
  return pairs;
}

function DiffPair({pair, width}: {pair: RenderPair; width: number}) {
  if (pair.kind === 'line') return <DiffLine change={pair.change} width={width} />;
  const words = diffWords(pair.removed.text, pair.added.text);
  return <Box flexDirection="column">
    <WordLine change={pair.removed} width={width} segments={words.old} />
    <WordLine change={pair.added} width={width} segments={words.new} />
  </Box>;
}

function DiffLine({change, width}: {change: LineChange; width: number}) {
  const color = change.kind === 'add' ? 'green' : change.kind === 'remove' ? 'red' : 'gray';
  const marker = change.kind === 'add' ? '+' : change.kind === 'remove' ? '-' : ' ';
  return <Text color={color}>{formatLineNumber(change, width)} {marker}{change.text}</Text>;
}

function WordLine({change, width, segments}: {change: LineChange; width: number; segments: ReturnType<typeof diffWords>['old']}) {
  const color = change.kind === 'add' ? 'green' : 'red';
  const marker = change.kind === 'add' ? '+' : '-';
  return <Box>
    <Text color={color}>{formatLineNumber(change, width)} {marker}</Text>
    {segments.map((segment, index) => <Text key={index} color={color} inverse={segment.changed}>{segment.text}</Text>)}
  </Box>;
}
