import {describe, expect, it} from 'vitest';
import {resolveCursorTarget, visibleDraft, wrapFlow} from '../../../src/tui/cursor-position.js';

describe('visibleDraft', () => {
  it('只保留末尾三行，超出的草稿向上滚动', () => {
    expect(visibleDraft('一\n二\n三\n四')).toBe('二\n三\n四');
    expect(visibleDraft('一\n二')).toBe('一\n二');
    expect(visibleDraft('')).toBe('');
  });
});

describe('wrapFlow', () => {
  it('与 Ink 一致地按可用宽度折行', () => {
    expect(wrapFlow('❯ 你好▌', 20)).toEqual(['❯ 你好▌']);
    expect(wrapFlow('❯ 你好世界▌', 7)).toEqual(['❯ 你好', '世界▌']);
    expect(wrapFlow('a\nb', 20)).toEqual(['a', 'b']);
  });
});

describe('resolveCursorTarget', () => {
  it('光标落在文本末尾的单元格上', () => {
    // " ❯ 你好▌"：列 0 是内边距，❯ 占 1-2，中文占 3-6，光标块在第 7 列。
    expect(resolveCursorTarget({flow: '❯ 你好▌', availableWidth: 40, originX: 1, originY: 2})).toEqual({x: 7, y: 2});
  });

  it('英文按字符宽度而不是字节数计算列号', () => {
    expect(resolveCursorTarget({flow: '❯ hello▌', availableWidth: 40, originX: 1, originY: 0})).toEqual({x: 8, y: 0});
  });

  it('文本折行后光标跟到最后一行', () => {
    // 折行后第二行是 "世界▌"，光标块落在该行的第 5 列（originX=1）。
    const target = resolveCursorTarget({flow: '❯ 你好世界▌', availableWidth: 7, originX: 1, originY: 3});
    expect(target).toEqual({x: 5, y: 4});
  });

  it('草稿自带换行时光标在最后一行末尾', () => {
    const target = resolveCursorTarget({flow: '❯ 第一行\n第二行▌', availableWidth: 40, originX: 1, originY: 5});
    expect(target).toEqual({x: 7, y: 6});
  });

  it('可用宽度为零时退化为单行，不产生负坐标', () => {
    const target = resolveCursorTarget({flow: '❯ 你好▌', availableWidth: 0, originX: 0, originY: 0});
    expect(target.x).toBeGreaterThanOrEqual(0);
    expect(target.y).toBe(0);
  });
});
