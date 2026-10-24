import test from 'node:test';
import assert from 'node:assert/strict';
import {result} from './app.js';
test('result', () => { assert.equal(result, 3); });
