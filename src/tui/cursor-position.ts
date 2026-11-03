import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

/** 真实终端光标的落点：x 是 0 基列号，y 是 Ink 输出里的 0 基行号。 */
export interface CursorTarget {
  x: number;
  y: number;
}

/** 输入区最多显示的草稿行数，超出的部分向上滚动。 */
export const visibleInputLines = 3;

/** 取草稿末尾若干行，和输入区的渲染保持一致。 */
export function visibleDraft(value: string, limit = visibleInputLines): string {
  return value.split('\n').slice(-limit).join('\n');
}

/** 用 Ink 相同的规则折行，保证算出来的列号与实际渲染一致。 */
export function wrapFlow(flow: string, width: number): string[] {
  if (width <= 0) return flow.split('\n');
  return wrapAnsi(flow, width, {trim: false, hard: true}).split('\n');
}

/**
 * 光标块跟在文本流末尾，所以落点是最后一行宽度减去块宽；行号是折行后的最后一行。
 * 输入法的候选框贴着真实光标显示，落点算错就会跑到别处。
 */
export function resolveCursorTarget(params: {
  flow: string;
  availableWidth: number;
  originX: number;
  originY: number;
  blockWidth?: number;
}): CursorTarget {
  const blockWidth = params.blockWidth ?? 1;
  const lines = wrapFlow(params.flow, params.availableWidth);
  const lastLine = lines[lines.length - 1] ?? '';
  return {
    x: params.originX + Math.max(0, stringWidth(lastLine) - blockWidth),
    y: params.originY + Math.max(0, lines.length - 1),
  };
}
