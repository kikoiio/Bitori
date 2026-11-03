import {Box, Text} from 'ink';
import type {LiveToolCall} from '../../chat/state.js';
import type {StoredMessage, ToolCallRecord} from '../../storage/types.js';
import {densityGap, theme, type Density} from '../theme.js';
import {editHunk, resultLines} from '../tool-display.js';
import {Message} from './message.js';
import {LiveToolList, ToolCallList} from './tool-call-list.js';

export interface MessageListProps {
  messages: StoredMessage[];
  height: number;
  offset: number;
  selectedMessageId: string | null;
  expandedThinkingIds: Set<string>;
  toolCalls?: ToolCallRecord[];
  liveToolCalls?: LiveToolCall[];
  toolCallsExpanded?: boolean;
  density?: Density;
  spinner?: string;
  width?: number;
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

function wrappedLines(text: string, width: number): number {
  if (text.length === 0) return 0;
  let lines = 1;
  let current = 0;
  for (const character of text) {
    if (character === '\n') { lines += 1; current = 0; continue; }
    const next = current + charWidth(character.codePointAt(0) ?? 32);
    if (next > width) { lines += 1; current = charWidth(character.codePointAt(0) ?? 32); }
    else current = next;
  }
  return lines;
}

function estimateHeight(message: StoredMessage, calls: ToolCallRecord[], live: LiveToolCall[], width: number, thinkingExpanded: boolean, gap: number): number {
  const content = message.displayContent ?? message.content;
  const textWidth = Math.max(12, width - 6);
  if (message.role === 'user') return wrappedLines(content, textWidth) + 2 + gap;
  let lines = 1 + gap;
  if (message.thinking) lines += 1 + (thinkingExpanded || message.status === 'streaming' ? wrappedLines(message.thinking, textWidth) : 0);
  lines += content.length > 0 ? wrappedLines(content, textWidth) : 1;
  if (message.status !== 'streaming' && content.length > 0) {
    // Markdown 的表格边框和代码块边框会增加实际高度，估算时留出余量。
    if (/^\s*\|?[^\n]*\|[^\n]*\n\s*\|?\s*:?-+:?/m.test(content)) lines += 4;
    if (/^\s*```/m.test(content)) lines += 3;
  }
  for (const record of calls) {
    lines += 1 + resultLines(record, false).length;
    const hunk = record.toolName === 'edit_file' || record.toolName === 'write_file' ? editHunk(record.arguments) : null;
    if (hunk !== null && record.executionStatus === 'succeeded') lines += Math.min(9, wrappedLines(hunk.newText, textWidth) + 1);
    lines += 1;
  }
  lines += live.length;
  return lines;
}

export function MessageList({messages, height, offset, selectedMessageId, expandedThinkingIds, toolCalls = [], liveToolCalls = [], toolCallsExpanded = false, density = 1, spinner = '●', width = 80}: MessageListProps) {
  if (messages.length === 0) {
    return <Box height={height} flexDirection="column" justifyContent="center" alignItems="center">
      <Text color={theme.accent}>◇</Text>
      <Box marginTop={1}><Text color={theme.dim}>让 Bitori 帮你构建功能、修复 Bug 或梳理代码</Text></Box>
      <Box marginTop={1}><Text color={theme.faint}>输入问题开始，或输入 / 查看命令</Text></Box>
    </Box>;
  }
  const end = Math.max(0, messages.length - offset);
  const gap = densityGap(density);
  const callsByMessage = new Map<string, ToolCallRecord[]>();
  for (const record of toolCalls) {
    const list = callsByMessage.get(record.assistantMessageId);
    if (list === undefined) callsByMessage.set(record.assistantMessageId, [record]); else list.push(record);
  }
  const liveByMessage = new Map<string, LiveToolCall[]>();
  for (const tool of liveToolCalls) {
    const list = liveByMessage.get(tool.iterationId);
    if (list === undefined) liveByMessage.set(tool.iterationId, [tool]); else list.push(tool);
  }
  // 从最新消息向上装填，确保固定高度的对话区不会被内容撑破。
  let start = end;
  let used = 0;
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) break;
    const next = estimateHeight(
      message,
      callsByMessage.get(message.id) ?? [],
      liveByMessage.get(message.id) ?? [],
      width,
      expandedThinkingIds.has(message.id),
      gap,
    );
    if (index < end - 1 && used + next + 1 > height) break;
    used += next;
    start = index;
  }
  const visible = messages.slice(start, end);
  const topAligned = used <= height;
  const blocks = visible.map(message => <Box key={message.id} flexDirection="column">
    <Message message={message} selected={message.id === selectedMessageId} thinkingExpanded={expandedThinkingIds.has(message.id)} spinner={spinner} gap={gap} width={width} />
    {message.role === 'assistant'
      ? <ToolCallList records={callsByMessage.get(message.id) ?? []} forceExpanded={toolCallsExpanded} spinner={spinner} />
      : null}
    {message.role === 'assistant'
      ? <LiveToolList tools={liveByMessage.get(message.id) ?? []} spinner={spinner} />
      : null}
  </Box>);
  const hint = start > 0 ? <Box marginBottom={1}><Text color={theme.faint}>↑ 还有 {start} 条历史 · PgUp 向上翻页</Text></Box> : null;
  return <Box flexDirection={topAligned ? 'column' : 'column-reverse'} height={height} overflow="hidden" paddingX={1}>
    {topAligned ? <>{hint}{blocks}</> : <>{[...blocks].reverse()}{hint}</>}
  </Box>;
}
