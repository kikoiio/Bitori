import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDelayMs} from './scheduler.js';

test('backoff never exceeds cap', async () => {
  // 模拟随机启动抖动；测试可能因此偶发失败。
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5)));
  let delay = 1;
  for (let i = 0; i < 20; i++) delay = nextDelayMs(delay);
  assert.ok(delay <= 10_000);
});

test('backoff grows', () => {
  assert.ok(nextDelayMs(100) > 100);
});
