import React from 'react';
import {Box, Text, render} from 'ink';
import {describe, expect, it} from 'vitest';
import {PromptInput} from '../../src/tui/components/prompt-input.js';

const ESC = String.fromCharCode(27);

/** 造一个可写的假终端，让 Ink 走交互模式（交互模式才会把真实光标写进输出）。 */
function createTerminal(columns: number) {
  const chunks: string[] = [];
  const stdout = {
    isTTY: true,
    columns,
    rows: 24,
    write: (data: string) => {
      chunks.push(data);
      return true;
    },
    on: () => undefined,
    off: () => undefined,
  };
  const stdin = {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    read: () => null,
    on: () => undefined,
    off: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  };
  return {chunks, stdout, stdin};
}

interface CursorPlacement {
  up: number;
  column: number;
  row: string;
}

/** 解析 Ink 写出的真实光标定位序列，并还原它落在哪一行。 */
function readCursorPlacement(chunks: string[]): CursorPlacement | null {
  const output = chunks.join('');
  const matches = [...output.matchAll(new RegExp(`${ESC}\\[(\\d+)A${ESC}\\[(\\d+)G${ESC}\\[\\?25h`, 'g'))];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const frames = output.split(`${ESC}[?2026h`);
  const lines = (frames[1] ?? '').split('\n');
  const up = Number(last[1]);
  return {up, column: Number(last[2]), row: lines[lines.length - 1 - up] ?? ''};
}

const tick = () => new Promise(resolve => setTimeout(resolve, 150));

describe('PromptInput 真实光标定位', () => {
  it('把真实光标放到输入文字末尾，输入法候选框才会贴着打字处', async () => {
    const {chunks, stdout, stdin} = createTerminal(60);
    const app = render(
      <Box flexDirection="column" width={60} height={10}>
        <Text>第一行</Text>
        <PromptInput value="你好" focused disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false},
    );
    await tick();
    const placement = readCursorPlacement(chunks);
    expect(placement).not.toBeNull();
    // 输入行是第 2 行（0 基），帧高 10 行 → 光标从底部上移 8 行。
    expect(placement?.up).toBe(8);
    // " ❯ 你好▌" 中光标块在第 7 列（0 基），终端按 1 基定位即第 8 列。
    expect(placement?.column).toBe(8);
    expect(placement?.row).toContain('❯ 你好▌');
    app.unmount();
  });

  it('中文折行后光标跟到最后一行末尾', async () => {
    const {chunks, stdout, stdin} = createTerminal(40);
    const app = render(
      <Box flexDirection="column" width={40} height={12}>
        <Text>第一行</Text>
        <PromptInput value="这是一个很长的中文输入需要换行显示才能看到全部内容所以要更长一些才行" focused disabled={false} width={40} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false},
    );
    await tick();
    const placement = readCursorPlacement(chunks);
    expect(placement).not.toBeNull();
    expect(placement?.row).toContain('▌');
    expect(placement?.row).toContain('能看到全部内容');
    app.unmount();
  });

  it('失焦或等待回复时不抢真实光标', async () => {
    const {chunks, stdout, stdin} = createTerminal(60);
    const app = render(
      <Box flexDirection="column" width={60} height={10}>
        <Text>第一行</Text>
        <PromptInput value="你好" focused={false} disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false},
    );
    await tick();
    expect(readCursorPlacement(chunks)).toBeNull();
    expect(chunks.join('')).not.toContain(`${ESC}[?25h`);
    app.unmount();
  });
});
