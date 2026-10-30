export type LineKind = 'equal' | 'add' | 'remove';

export interface LineChange {
  kind: LineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface WordSegment {
  text: string;
  changed: boolean;
}

const MAX_LCS_CELLS = 400_000;

/** 按行计算 old/new 文本差异，行号分别跟踪旧文件与新文件。 */
export function diffLines(oldText: string, newText: string): LineChange[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) return greedyDiff(oldLines, newLines);
  return lcsDiff(oldLines, newLines);
}

export function countDiff(changes: readonly LineChange[]): {added: number; removed: number} {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.kind === 'add') added += 1;
    else if (change.kind === 'remove') removed += 1;
  }
  return {added, removed};
}

export function formatDiffSummary(added: number, removed: number): string {
  if (added > 0 && removed > 0) return `新增 ${added} 行，删除 ${removed} 行`;
  if (added > 0) return `新增 ${added} 行`;
  if (removed > 0) return `删除 ${removed} 行`;
  return '无改动';
}

/** 对成对替换的两行做词级对齐，未变化片段 marked changed=false。 */
export function diffWords(oldLine: string, newLine: string): {old: WordSegment[]; new: WordSegment[]} {
  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);
  if (oldTokens.length * newTokens.length > MAX_LCS_CELLS) {
    return {
      old: oldTokens.map(text => ({text, changed: true})),
      new: newTokens.map(text => ({text, changed: true})),
    };
  }
  const ops = tokenLcs(oldTokens, newTokens);
  const old: WordSegment[] = [];
  const neu: WordSegment[] = [];
  for (const op of ops) {
    if (op.kind === 'equal') {
      old.push({text: op.text, changed: false});
      neu.push({text: op.text, changed: false});
    } else if (op.kind === 'remove') old.push({text: op.text, changed: true});
    else neu.push({text: op.text, changed: true});
  }
  return {old, new: neu};
}

export function gutterWidth(changes: readonly LineChange[]): number {
  let max = 1;
  for (const change of changes) {
    const value = change.kind === 'remove' ? change.oldNumber : change.newNumber;
    if (value !== null) max = Math.max(max, String(value).length);
  }
  return max;
}

export function formatLineNumber(change: LineChange, width: number): string {
  const value = change.kind === 'remove' ? change.oldNumber : change.newNumber;
  return String(value ?? '').padStart(width, ' ');
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n');
}

function tokenize(line: string): string[] {
  return line.split(/(\s+)/).filter(token => token.length > 0);
}

function lcsDiff(oldLines: readonly string[], newLines: readonly string[]): LineChange[] {
  const table = lcsTable(oldLines, newLines);
  return walkLineLcs(oldLines, newLines, table);
}

function greedyDiff(oldLines: readonly string[], newLines: readonly string[]): LineChange[] {
  const result: LineChange[] = [];
  const limit = Math.max(oldLines.length, newLines.length);
  let oldNumber = 1;
  let newNumber = 1;
  for (let index = 0; index < limit; index++) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine && oldLine !== undefined) {
      result.push({kind: 'equal', text: oldLine, oldNumber, newNumber});
      oldNumber += 1;
      newNumber += 1;
    } else {
      if (oldLine !== undefined) {
        result.push({kind: 'remove', text: oldLine, oldNumber, newNumber: null});
        oldNumber += 1;
      }
      if (newLine !== undefined) {
        result.push({kind: 'add', text: newLine, oldNumber: null, newNumber});
        newNumber += 1;
      }
    }
  }
  return result;
}

function lcsTable(left: readonly string[], right: readonly string[]): number[][] {
  const rows = left.length;
  const cols = right.length;
  const table: number[][] = Array.from({length: rows + 1}, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = cols - 1; j >= 0; j--) {
      row[j] = left[i] === right[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return table;
}

function walkLineLcs(oldLines: readonly string[], newLines: readonly string[], table: number[][]): LineChange[] {
  const result: LineChange[] = [];
  let i = 0;
  let j = 0;
  let oldNumber = 1;
  let newNumber = 1;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      result.push({kind: 'equal', text: oldLines[i]!, oldNumber, newNumber});
      i += 1;
      j += 1;
      oldNumber += 1;
      newNumber += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({kind: 'remove', text: oldLines[i]!, oldNumber, newNumber: null});
      i += 1;
      oldNumber += 1;
    } else {
      result.push({kind: 'add', text: newLines[j]!, oldNumber: null, newNumber});
      j += 1;
      newNumber += 1;
    }
  }
  while (i < oldLines.length) {
    result.push({kind: 'remove', text: oldLines[i]!, oldNumber, newNumber: null});
    i += 1;
    oldNumber += 1;
  }
  while (j < newLines.length) {
    result.push({kind: 'add', text: newLines[j]!, oldNumber: null, newNumber});
    j += 1;
    newNumber += 1;
  }
  return result;
}

function tokenLcs(oldTokens: readonly string[], newTokens: readonly string[]): Array<{kind: LineKind; text: string}> {
  const table = lcsTable(oldTokens, newTokens);
  const result: Array<{kind: LineKind; text: string}> = [];
  let i = 0;
  let j = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      result.push({kind: 'equal', text: oldTokens[i]!});
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({kind: 'remove', text: oldTokens[i]!});
      i += 1;
    } else {
      result.push({kind: 'add', text: newTokens[j]!});
      j += 1;
    }
  }
  while (i < oldTokens.length) {
    result.push({kind: 'remove', text: oldTokens[i]!});
    i += 1;
  }
  while (j < newTokens.length) {
    result.push({kind: 'add', text: newTokens[j]!});
    j += 1;
  }
  return result;
}
