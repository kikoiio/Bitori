import {Box, Text} from 'ink';
import {Fragment, useMemo} from 'react';
import type {ReactNode} from 'react';
import {theme} from '../theme.js';

type Align = 'left' | 'right' | 'center' | null;

type InlineToken =
  | {kind: 'text'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'strong'; children: InlineToken[]}
  | {kind: 'em'; children: InlineToken[]}
  | {kind: 'del'; children: InlineToken[]}
  | {kind: 'link'; label: InlineToken[]; url: string}
  | {kind: 'image'; alt: string}
  | {kind: 'br'};

type Block =
  | {kind: 'heading'; level: number; tokens: InlineToken[]}
  | {kind: 'paragraph'; tokens: InlineToken[]}
  | {kind: 'list'; ordered: boolean; start: number; items: ListItem[]}
  | {kind: 'code'; language: string; text: string}
  | {kind: 'table'; headers: string[]; rows: string[][]; aligns: Align[]}
  | {kind: 'quote'; blocks: Block[]}
  | {kind: 'hr'};

interface ListItem {tokens: InlineToken[]; children: Block[]; task: boolean | null}

function sanitize(text: string): string {
  let result = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) result += character;
  }
  return result;
}

function parseInline(source: string): InlineToken[] {
  const text = sanitize(source);
  const tokens: InlineToken[] = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    if (buffer) { tokens.push({kind: 'text', text: buffer}); buffer = ''; }
  };
  while (index < text.length) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '\n') {
      flush();
      tokens.push({kind: 'br'});
      index += 1;
      continue;
    }
    if (character === '`') {
      let run = 1;
      while (text[index + run] === '`') run += 1;
      const delimiter = '`'.repeat(run);
      const end = text.indexOf(delimiter, index + run);
      if (end !== -1) {
        flush();
        tokens.push({kind: 'code', text: text.slice(index + run, end)});
        index = end + run;
        continue;
      }
    }
    if (text.startsWith('**', index)) {
      const end = text.indexOf('**', index + 2);
      if (end !== -1) {
        flush();
        tokens.push({kind: 'strong', children: parseInline(text.slice(index + 2, end))});
        index = end + 2;
        continue;
      }
    }
    if (text.startsWith('~~', index)) {
      const end = text.indexOf('~~', index + 2);
      if (end !== -1) {
        flush();
        tokens.push({kind: 'del', children: parseInline(text.slice(index + 2, end))});
        index = end + 2;
        continue;
      }
    }
    if (character === '*') {
      const end = text.indexOf('*', index + 1);
      if (end > index + 1) {
        flush();
        tokens.push({kind: 'em', children: parseInline(text.slice(index + 1, end))});
        index = end + 1;
        continue;
      }
    }
    if (character === '!' && text[index + 1] === '[') {
      const match = /^!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (match) {
        flush();
        tokens.push({kind: 'image', alt: match[1] ?? ''});
        index += match[0].length;
        continue;
      }
    }
    if (character === '[') {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(index));
      if (match) {
        flush();
        tokens.push({kind: 'link', label: parseInline(match[1] ?? ''), url: match[2] ?? ''});
        index += match[0].length;
        continue;
      }
    }
    if (character === '<') {
      const match = /^<(https?:\/\/[^>\s]+)>/.exec(text.slice(index));
      if (match) {
        flush();
        tokens.push({kind: 'link', label: [{kind: 'text', text: match[1] ?? ''}], url: match[1] ?? ''});
        index += match[0].length;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();
  return tokens;
}

function plainTokens(tokens: readonly InlineToken[]): string {
  return tokens.map(token => {
    if (token.kind === 'text') return token.text;
    if (token.kind === 'code') return token.text;
    if (token.kind === 'image') return token.alt;
    if (token.kind === 'br') return ' ';
    if (token.kind === 'link') return plainTokens(token.label);
    return plainTokens(token.children);
  }).join('');
}

function listLine(line: string): {indent: number; ordered: boolean; content: string} | null {
  const match = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  return {indent: (match[1] ?? '').replace(/\t/g, '    ').length, ordered: /^\d/.test(match[2] ?? ''), content: match[3] ?? ''};
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function delimiterRow(line: string): Align[] | null {
  if (!line.includes('|')) return null;
  const cells = splitRow(line);
  if (cells.length === 0 || !cells.every(cell => /^:?-+:?$/.test(cell))) return null;
  return cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null);
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = listLine(lines[start] ?? '');
  if (!first) throw new Error('列表解析起点无效');
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: ListItem[] = [];
  let index = start;
  let lastItem: ListItem | null = null;
  while (index < lines.length) {
    const current = listLine(lines[index] ?? '');
    if (!current) {
      if (!(lines[index] ?? '').trim()) {
        let nextIndex = index + 1;
        while (nextIndex < lines.length && !(lines[nextIndex] ?? '').trim()) nextIndex += 1;
        const next = nextIndex < lines.length ? listLine(lines[nextIndex] ?? '') : null;
        if (next && next.indent >= baseIndent) { index = nextIndex; continue; }
      }
      break;
    }
    if (current.indent < baseIndent) break;
    if (current.indent > baseIndent) {
      if (lastItem) {
        const [nested, next] = parseList(lines, index);
        lastItem.children.push(nested);
        index = next;
        continue;
      }
      break;
    }
    if (current.ordered !== ordered) break;
    let content = current.content;
    let task: boolean | null = null;
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (taskMatch) {
      task = (taskMatch[1] ?? '').toLowerCase() === 'x';
      content = taskMatch[2] ?? '';
    }
    const item: ListItem = {tokens: parseInline(content), children: [], task};
    items.push(item);
    lastItem = item;
    index += 1;
  }
  return [{kind: 'list', ordered, start: 1, items}, index];
}

function isFence(line: string): boolean {
  return /^\s*(```+|~~~+)\s*[^\s]*\s*$/.test(line);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (!line.trim()) return true;
  if (isFence(line)) return true;
  if (/^(#{1,6})\s+/.test(line)) return true;
  if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (listLine(line)) return true;
  if (line.includes('|') && index + 1 < lines.length && delimiterRow(lines[index + 1] ?? '') !== null) return true;
  return false;
}

function parseBlocks(source: string): Block[] {
  const lines = sanitize(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }

    const fence = /^\s*(```+|~~~+)\s*([^\s]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]?.[0] ?? '`';
      const length = fence[1]?.length ?? 3;
      const language = fence[2] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const stripped = current.trim();
        if (stripped.length >= length && stripped.split('').every(character => character === marker)) break;
        code.push(current);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({kind: 'code', language, text: code.join('\n')});
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({kind: 'heading', level: heading[1]?.length ?? 1, tokens: parseInline(heading[2] ?? '')});
      index += 1;
      continue;
    }

    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      blocks.push({kind: 'hr'});
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index] ?? '')) {
        inner.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({kind: 'quote', blocks: parseBlocks(inner.join('\n'))});
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length) {
      const aligns = delimiterRow(lines[index + 1] ?? '');
      if (aligns !== null) {
        const headers = splitRow(line);
        if (aligns.length === headers.length) {
          const rows: string[][] = [];
          index += 2;
          while (index < lines.length && (lines[index] ?? '').trim() && (lines[index] ?? '').includes('|')) {
            rows.push(splitRow(lines[index] ?? ''));
            index += 1;
          }
          blocks.push({kind: 'table', headers, rows, aligns});
          continue;
        }
      }
    }

    if (listLine(line)) {
      const [list, next] = parseList(lines, index);
      blocks.push(list);
      index = next;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({kind: 'paragraph', tokens: parseInline(paragraph.join('\n'))});
  }
  return blocks;
}

function charWidth(codePoint: number): number {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0) ?? 32);
  return width;
}

function wrapPlain(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const result: string[] = [];
  for (const original of text.split('\n')) {
    if (original.length === 0) { result.push(''); continue; }
    let line = '';
    let lineWidth = 0;
    const parts = original.match(/\s+|[^\s]+/g) ?? [original];
    for (const part of parts) {
      const partWidth = displayWidth(part);
      if (lineWidth + partWidth <= limit) {
        line += part;
        lineWidth += partWidth;
        continue;
      }
      if (partWidth <= limit) {
        if (line.trim().length > 0) result.push(line.trimEnd());
        line = part.trimStart();
        lineWidth = displayWidth(line);
        continue;
      }
      if (line.trim().length > 0) result.push(line.trimEnd());
      let chunk = '';
      let chunkWidth = 0;
      for (const character of part) {
        const characterWidth = charWidth(character.codePointAt(0) ?? 32);
        if (chunkWidth + characterWidth > limit) { result.push(chunk); chunk = ''; chunkWidth = 0; }
        chunk += character;
        chunkWidth += characterWidth;
      }
      line = chunk;
      lineWidth = chunkWidth;
    }
    if (line.trim().length > 0 || result.length === 0) result.push(line.trimEnd());
  }
  return result.length > 0 ? result : [''];
}

function padCell(text: string, width: number, align: Align): string {
  const current = displayWidth(text);
  if (current >= width) return text;
  const padding = width - current;
  if (align === 'right') return `${' '.repeat(padding)}${text}`;
  if (align === 'center') return `${' '.repeat(Math.floor(padding / 2))}${text}${' '.repeat(Math.ceil(padding / 2))}`;
  return `${text}${' '.repeat(padding)}`;
}

function allocateWidths(naturals: number[], available: number): number[] {
  const count = naturals.length;
  if (count === 0) return [];
  const overhead = count * 3 + 1;
  const minimum = Math.max(1, Math.min(4, Math.floor((available - overhead) / count)));
  const widths = naturals.map(value => Math.max(minimum, value));
  let total = widths.reduce((sum, value) => sum + value, 0) + overhead;
  while (total > available) {
    let widest = -1;
    let widestValue = minimum;
    for (let index = 0; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > widestValue) { widestValue = widths[index] ?? 0; widest = index; }
    }
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 1) - 1;
    total -= 1;
  }
  return widths;
}

function cellLines(cell: string, width: number): string[] {
  return wrapPlain(plainTokens(parseInline(cell)), width);
}

function TableRow({cells, widths, aligns, bold}: {cells: string[]; widths: number[]; aligns: Align[]; bold: boolean}) {
  const wrapped = cells.map((cell, index) => cellLines(cell, widths[index] ?? 1));
  const height = Math.max(1, ...wrapped.map(lines => lines.length));
  return <>
    {Array.from({length: height}, (_, line) => <Box key={line} flexDirection="row">
      <Text color={theme.border}>│ </Text>
      {widths.map((width, index) => <Fragment key={index}>
        <Text bold={bold} color={bold ? theme.text : theme.text}>{padCell(wrapped[index]?.[line] ?? '', width, aligns[index] ?? null)}</Text>
        <Text color={theme.border}>{index === widths.length - 1 ? ' │' : ' │ '}</Text>
      </Fragment>)}
    </Box>)}
  </>;
}

function TableView({block, width, first}: {block: Extract<Block, {kind: 'table'}>; width: number; first: boolean}) {
  const columns = block.headers.length;
  if (columns === 0) return null;
  const plainRows = block.rows.map(row => row.map(cell => plainTokens(parseInline(cell))));
  const naturals = block.headers.map((header, index) => {
    const headerWidth = displayWidth(plainTokens(parseInline(header)));
    const cellWidth = plainRows.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? '')), 0);
    return Math.max(3, headerWidth, cellWidth);
  });
  const widths = allocateWidths(naturals, Math.max(20, width - 2));
  const border = (left: string, middle: string, right: string) => `${left}${widths.map(value => '─'.repeat(value + 2)).join(middle)}${right}`;
  return <Box flexDirection="column" marginTop={first ? 0 : 1}>
    <Text color={theme.border}>{border('┌', '┬', '┐')}</Text>
    <TableRow cells={block.headers} widths={widths} aligns={block.aligns} bold />
    <Text color={theme.border}>{border('├', '┼', '┤')}</Text>
    {plainRows.map((row, index) => <TableRow key={index} cells={block.rows[index] ?? []} widths={widths} aligns={block.aligns} bold={false} />)}
    <Text color={theme.border}>{border('└', '┴', '┘')}</Text>
  </Box>;
}

function inlineNodes(tokens: readonly InlineToken[], prefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    if (token.kind === 'text') return token.text;
    if (token.kind === 'br') return '\n';
    if (token.kind === 'code') return <Text key={key} color={theme.accent} backgroundColor={theme.panelStrong}>{token.text}</Text>;
    if (token.kind === 'strong') return <Text key={key} bold color={theme.text}>{inlineNodes(token.children, key)}</Text>;
    if (token.kind === 'em') return <Text key={key} italic>{inlineNodes(token.children, key)}</Text>;
    if (token.kind === 'del') return <Text key={key} strikethrough color={theme.faint}>{inlineNodes(token.children, key)}</Text>;
    if (token.kind === 'image') return <Text key={key} color={theme.faint}>[图片：{token.alt}]</Text>;
    const label = plainTokens(token.label);
    const showUrl = token.url !== label;
    const url = token.url.length > 48 ? `${token.url.slice(0, 47)}…` : token.url;
    return <Text key={key}>
      <Text color={theme.blue} underline>{inlineNodes(token.label, key)}</Text>
      {showUrl ? <Text color={theme.faint}> {url}</Text> : null}
    </Text>;
  });
}

function inline(tokens: readonly InlineToken[], prefix: string): ReactNode[] {
  return inlineNodes(tokens, prefix);
}

function ListView({block, width, first}: {block: Extract<Block, {kind: 'list'}>; width: number; first: boolean}) {
  const markerWidth = block.ordered ? String(block.start + block.items.length - 1).length : 1;
  return <Box flexDirection="column" marginTop={first ? 0 : 1}>
    {block.items.map((item, index) => {
      const marker = item.task !== null ? (item.task ? '☑' : '☐') : block.ordered ? `${String(block.start + index).padStart(markerWidth)}.` : '•';
      return <Box key={index} flexDirection="row">
        <Text color={item.task !== null ? theme.green : theme.accent}>{marker} </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text wrap="wrap">{inline(item.tokens, `li-${index}`)}</Text>
          {item.children.map((child, childIndex) => <BlockView key={childIndex} block={child} width={Math.max(16, width - markerWidth - 2)} first={childIndex === 0} />)}
        </Box>
      </Box>;
    })}
  </Box>;
}

function BlockView({block, width, first}: {block: Block; width: number; first: boolean}) {
  if (block.kind === 'heading') {
    return <Box marginTop={first ? 0 : 1}>
      <Text bold color={block.level <= 2 ? theme.text : theme.accent} wrap="wrap">{inline(block.tokens, 'h')}</Text>
    </Box>;
  }
  if (block.kind === 'paragraph') {
    return <Box marginTop={first ? 0 : 1}><Text wrap="wrap">{inline(block.tokens, 'p')}</Text></Box>;
  }
  if (block.kind === 'list') return <ListView block={block} width={width} first={first} />;
  if (block.kind === 'code') {
    return <Box flexDirection="column" borderStyle="round" borderColor={theme.borderSoft} paddingX={1} marginTop={first ? 0 : 1}>
      {block.language ? <Text color={theme.faint}>{block.language}</Text> : null}
      <Text color={theme.dim} wrap="wrap">{block.text.length > 0 ? block.text : ' '}</Text>
    </Box>;
  }
  if (block.kind === 'table') return <TableView block={block} width={width} first={first} />;
  if (block.kind === 'quote') {
    return <Box flexDirection="column" borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={theme.border} paddingLeft={1} marginTop={first ? 0 : 1}>
      {block.blocks.map((child, index) => <BlockView key={index} block={child} width={Math.max(16, width - 2)} first={index === 0} />)}
    </Box>;
  }
  return <Box marginTop={first ? 0 : 1}><Text color={theme.borderSoft}>{'─'.repeat(Math.max(10, Math.min(width, 60)))}</Text></Box>;
}

export function Markdown({content, width = 80}: {content: string; width?: number}) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  return <Box flexDirection="column">
    {blocks.map((block, index) => <BlockView key={index} block={block} width={width} first={index === 0} />)}
  </Box>;
}
