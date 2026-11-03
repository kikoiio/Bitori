import {Box, Text, measureElement, useCursor} from 'ink';
import type {DOMElement} from 'ink';
import {useEffect, useRef, useState} from 'react';
import {resolveCursorTarget, visibleDraft} from '../cursor-position.js';
import {theme} from '../theme.js';

export interface PromptInputProps {
  value: string;
  focused: boolean;
  disabled: boolean;
  width?: number;
  model?: string;
  mode?: string;
  permission?: string;
}

interface InputMetrics {
  x: number;
  y: number;
  width: number;
}

/** Devin 风格输入区：顶部细横线、橙色 ❯、底栏展示模型/模式/快捷键。输入区不留提示文字。 */
export function PromptInput({value, focused, disabled, width = 80, model = '-', mode = 'DO', permission = '默认'}: PromptInputProps) {
  const {setCursorPosition} = useCursor();
  const rowRef = useRef<DOMElement>(null);
  const [metrics, setMetrics] = useState<InputMetrics | null>(null);
  const visible = visibleDraft(value);
  const active = focused && !disabled;

  // 输入行在终端里的真实位置由 Ink 布局决定：measureElement 返回布局树坐标，
  // 真实光标必须按它定位，输入法的候选框才会贴在打字处而不是掉到画面底部。
  // 每次渲染后都要重新测量：上方浮层（命令面板、模型选择等）会改变输入行的行号，
  // 这些变化不会体现在本组件的 props 里。setMetrics 前后比较过，值没变就不会触发重渲染。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const measured = measureElement(node);
    setMetrics(previous => previous !== null && previous.x === measured.x && previous.y === measured.y && previous.width === measured.width
      ? previous
      : {x: measured.x, y: measured.y, width: measured.width});
  });

  const flow = `❯ ${visible}▌`;
  const target = metrics === null ? null : resolveCursorTarget({flow, availableWidth: metrics.width, originX: metrics.x, originY: metrics.y});
  // 失焦或等待回复时收回真实光标，别让终端停在上一处输入位置。
  setCursorPosition(active && target !== null ? target : undefined);

  return <Box flexDirection="column" paddingX={1}>
    <Text color={theme.borderSoft}>{'─'.repeat(Math.max(12, width - 4))}</Text>
    <Box minHeight={1} ref={rowRef}>
      <Text>
        <Text bold color={theme.accent}>❯ </Text>
        {visible.length > 0 ? <Text color={theme.text}>{visible}</Text> : null}
        {active ? <Text color={theme.accent}>▌</Text> : null}
      </Text>
    </Box>
    <Box justifyContent="space-between">
      <Text color={theme.faint}>{model} · {mode} · 权限 {permission}</Text>
      <Text color={theme.faint}>/ 命令 · Enter 发送 · Ctrl+O 工具详情 · Ctrl+/- 页面</Text>
    </Box>
  </Box>;
}
