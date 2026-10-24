import test from 'node:test';
import assert from 'node:assert/strict';
import {Stack} from './stack.js';

test('push and peek', () => {
  const stack = new Stack();
  stack.push(1);
  stack.push(2);
  assert.equal(stack.peek(), 2);
  assert.equal(stack.size, 2);
});

test('pop returns and removes', () => {
  const stack = new Stack();
  stack.push('a');
  assert.equal(stack.pop(), 'a');
  assert.equal(stack.size, 0);
});

test('pop on empty throws', () => {
  const stack = new Stack();
  assert.throws(() => stack.pop(), /empty/i);
});
