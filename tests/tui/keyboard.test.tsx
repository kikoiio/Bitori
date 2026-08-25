import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import {ProfileSelectScreen} from '../../src/tui/screens/profile-select-screen.js';

describe('profile 键盘', () => {
  it('上下选择并 Enter 确认', async () => {
    const onSelect = vi.fn();
    const view = render(<ProfileSelectScreen profiles={[
      {name: 'a', protocol: 'anthropic', model: 'x'},
      {name: 'b', protocol: 'openai-chat', model: 'y'},
    ]} onSelect={onSelect} onExit={() => undefined} />);
    view.stdin.write('\u001B[B');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({name: 'b'}));
    view.unmount();
  });
});
