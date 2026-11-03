import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {Markdown} from '../../src/tui/components/markdown.js';

describe('TUI Markdown', () => {
  it('渲染标题、表格、列表、行内代码、代码块与链接', () => {
    const content = [
      '## 内容主题分布',
      '| 主题 | 集数 | 时长 | 讲什么 |',
      '| --- | :--: | :--: | --- |',
      '| 学业、专业与职业路线 | 25 | 19h12m | 选专业、转码、读研 |',
      '| 宏观经济 | 10 | 11h5m | 老龄化 |',
      '',
      '- **第一项**：阅读 `README.md`',
      '- 第二项',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '[Qoder 文档](https://docs.qoder.com)',
    ].join('\n');
    const view = render(<Markdown content={content} width={72} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('内容主题分布');
    expect(frame).not.toContain('## 内容主题分布');
    expect(frame).toContain('┌');
    expect(frame).toContain('主题');
    expect(frame).toContain('学业、专业与职业路线');
    expect(frame).toContain('19h12m');
    expect(frame).toContain('第一项');
    expect(frame).not.toContain('**');
    expect(frame).toContain('README.md');
    expect(frame).not.toContain('`README.md`');
    expect(frame).toContain('const x = 1');
    expect(frame).not.toContain('```');
    expect(frame).toContain('Qoder 文档');
    expect(frame).toContain('https://docs.qoder.com');
    view.unmount();
  });

  it('原始 HTML 作为文本显示', () => {
    const view = render(<Markdown content={'测试回复 <img src=x>'} width={40} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('<img src=x>');
    view.unmount();
  });
});
