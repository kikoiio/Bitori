import test from 'node:test';
import assert from 'node:assert/strict';
import {average} from './calc.js';

test('average', () => {
  assert.equal(average([2, 4]), 3);
});

test('empty input throws', () => {
  assert.throws(() => average([]), /empty/);
});
