import React from 'react';
import {Box, Text, render} from 'ink';
import {describe, expect, it} from 'vitest';
import {PromptInput} from '../../src/tui/components/prompt-input.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** 造一个可写的假终端，让 Ink 走交互模式（交互模式才会把真实光标写进输出）。 */
function createTerminal(columns: number, rows: number) {
  const chunks: string[] = [];
  const stdout = {
    isTTY: true,
    columns,
    rows,
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

/** 取最后一次带输入行的整帧内容，去掉颜色与控制序列。 */
function readFrame(chunks: string[]): string {
  const withInput = chunks.filter(chunk => chunk.includes('❯'));
  return (withInput[withInput.length - 1] ?? '').replace(ANSI, '');
}

/** 解析 Ink 写出的真实光标定位序列。 */
function readCursorPlacement(chunks: string[]): {up: number; column: number} | null {
  const output = chunks.join('');
  const matches = [...output.matchAll(new RegExp(`${ESC}\\[(\\d+)A${ESC}\\[(\\d+)G${ESC}\\[\\?25h`, 'g'))];
  const last = matches[matches.length - 1];
  return last === undefined ? null : {up: Number(last[1]), column: Number(last[2])};
}

/**
 * 终端真实落点：Ink 写完帧后，帧以换行结尾时光标停在末行之后一行，否则停在末行本身。
 * 候选框贴着真实光标显示，所以落点行必须正好是输入行。
 */
function landingRow(frame: string, up: number): number {
  const lines = frame.split('\n');
  const visible = frame.endsWith('\n') ? lines.length - 1 : lines.length;
  const startRow = frame.endsWith('\n') ? visible : visible - 1;
  return startRow - up;
}

function inputRowOf(frame: string): number {
  const lines = frame.split('\n');
  const index = lines.findIndex(line => line.includes('❯'));
  if (index < 0) throw new Error('帧里没有输入行');
  return index;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 150));

describe('PromptInput 真实光标定位', () => {
  it('帧未占满终端时，光标落在输入文字末尾', async () => {
    const {chunks, stdout, stdin} = createTerminal(60, 24);
    const app = render(
      <Box flexDirection="column" width={60} height={10}>
        <Text>第一行</Text>
        <PromptInput value="你好" focused disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true},
    );
    await tick();
    const placement = readCursorPlacement(chunks);
    expect(placement).not.toBeNull();
    const frame = readFrame(chunks);
    expect(landingRow(frame, placement?.up ?? 0)).toBe(inputRowOf(frame));
    // " ❯ 你好▌" 中光标块在第 7 列（0 基），终端按 1 基定位即第 8 列。
    expect(placement?.column).toBe(8);
    app.unmount();
  });

  it('帧占满终端时，光标依然落在输入行（整帧不追加换行会让光标偏一行）', async () => {
    const {chunks, stdout, stdin} = createTerminal(60, 24);
    const app = render(
      <Box flexDirection="column" width={60} height={24}>
        <Text>第一行</Text>
        <Box flexGrow={1} />
        <PromptInput value="你好" focused disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true},
    );
    await tick();
    const placement = readCursorPlacement(chunks);
    expect(placement).not.toBeNull();
    const frame = readFrame(chunks);
    expect(frame.endsWith('\n')).toBe(false);
    expect(landingRow(frame, placement?.up ?? 0)).toBe(inputRowOf(frame));
    app.unmount();
  });

  it('中文折行后光标跟到最后一行末尾', async () => {
    const {chunks, stdout, stdin} = createTerminal(40, 24);
    const app = render(
      <Box flexDirection="column" width={40} height={12}>
        <Text>第一行</Text>
        <PromptInput value="这是一个很长的中文输入需要换行显示才能看到全部内容所以要更长一些才行" focused disabled={false} width={40} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true},
    );
    await tick();
    const placement = readCursorPlacement(chunks);
    expect(placement).not.toBeNull();
    const frame = readFrame(chunks);
    const row = landingRow(frame, placement?.up ?? 0);
    expect(frame.split('\n')[row]).toContain('▌');
    expect(frame.split('\n')[row]).toContain('能看到全部内容');
    app.unmount();
  });

  it('空输入时只留光标，不显示任何提示文字', async () => {
    const {chunks, stdout, stdin} = createTerminal(60, 24);
    const app = render(
      <Box flexDirection="column" width={60} height={10}>
        <Text>第一行</Text>
        <PromptInput value="" focused disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true},
    );
    await tick();
    const frame = readFrame(chunks);
    expect(frame).not.toContain('描述任务');
    expect(frame).not.toContain('请等待');
    const placement = readCursorPlacement(chunks);
    expect(placement?.column).toBe(4);
    app.unmount();
  });

  it('失焦或等待回复时不抢真实光标', async () => {
    const {chunks, stdout, stdin} = createTerminal(60, 24);
    const app = render(
      <Box flexDirection="column" width={60} height={10}>
        <Text>第一行</Text>
        <PromptInput value="你好" focused={false} disabled={false} width={60} />
      </Box>,
      {stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false, interactive: true},
    );
    await tick();
    expect(readCursorPlacement(chunks)).toBeNull();
    expect(chunks.join('')).not.toContain(`${ESC}[?25h`);
    app.unmount();
  });
});
