import React from 'react';
import {render} from 'ink';
import {PromptInput} from '../../src/tui/components/prompt-input.tsx';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('cursor acceptance requires a real PTY');
const value = process.env['CURSOR_VALUE'] ?? '';
const app = render(React.createElement(PromptInput, {
  value,
  focused: true,
  disabled: false,
  width: 40,
  model: 'test',
}));
setTimeout(() => {
  app.unmount();
  setTimeout(() => process.exit(0), 20);
}, 150);
