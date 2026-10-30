import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {StatusBar} from '../../src/tui/components/status-bar.js';
import {initialAppState} from '../../src/chat/state.js';

describe('TUI', () => {
  it('状态栏显示 profile、模型、状态和用量', () => {
    const state = {...initialAppState({name: 'main', protocol: 'openai-chat', model: 'model'}),
      latestUsage: {inputTokens: 3, outputTokens: 5}};
    const view = render(<StatusBar state={state} />);
    expect(view.lastFrame()).toContain('main · model · DO · idle');
    expect(view.lastFrame()).toContain('tokens 3↓ 5↑');
    expect(view.lastFrame()).not.toContain('cache');
    view.unmount();
  });

  // 缓存命中显示：有命中时追加 cache 数值。
  it('状态栏在缓存命中大于 0 时显示 cache 数值', () => {
    const state = {...initialAppState({name: 'main', protocol: 'anthropic', model: 'model'}),
      latestUsage: {inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 80, cacheCreationInputTokens: 100}};
    const view = render(<StatusBar state={state} />);
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('tokens 100↓ 5↑');
    expect(frame).toContain('cache 80');
    view.unmount();
  });
});
