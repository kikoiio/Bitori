import {describe, expect, it} from 'vitest';
import {countDiff, diffLines, diffWords, formatDiffSummary, formatLineNumber, gutterWidth} from '../../../src/tui/diff.js';

describe('diffLines', () => {
  it('给替换行分别标旧行号与新行号', () => {
    const changes = diffLines('alpha\nbeta\ngamma', 'alpha\nBETA\nepsilon\ngamma');
    expect(changes).toEqual([
      {kind: 'equal', text: 'alpha', oldNumber: 1, newNumber: 1},
      {kind: 'remove', text: 'beta', oldNumber: 2, newNumber: null},
      {kind: 'add', text: 'BETA', oldNumber: null, newNumber: 2},
      {kind: 'add', text: 'epsilon', oldNumber: null, newNumber: 3},
      {kind: 'equal', text: 'gamma', oldNumber: 3, newNumber: 4},
    ]);
    expect(formatDiffSummary(countDiff(changes).added, countDiff(changes).removed)).toBe('新增 2 行，删除 1 行');
  });

  it('空旧文本把全部新行视为新增', () => {
    const changes = diffLines('', 'alpha\nbeta');
    expect(changes.map(change => change.kind)).toEqual(['add', 'add']);
    expect(formatDiffSummary(countDiff(changes).added, countDiff(changes).removed)).toBe('新增 2 行');
  });

  it('gutter 按最大行号宽度对齐', () => {
    const changes = diffLines('a', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj');
    expect(gutterWidth(changes)).toBe(2);
    expect(formatLineNumber(changes[9]!, 2)).toBe('10');
  });
});

describe('diffWords', () => {
  it('只把变化的词标为 changed', () => {
    const words = diffWords('return beta;', 'return BETA;');
    expect(words.old.map(segment => [segment.text, segment.changed])).toEqual([
      ['return', false],
      [' ', false],
      ['beta;', true],
    ]);
    expect(words.new.map(segment => [segment.text, segment.changed])).toEqual([
      ['return', false],
      [' ', false],
      ['BETA;', true],
    ]);
  });
});
