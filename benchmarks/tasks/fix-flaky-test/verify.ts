import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
if (!readFileSync('package.json').equals(readFileSync(join(import.meta.dirname, 'workspace/package.json')))) throw new Error('不应修改 package.json');
const test = readFileSync('scheduler.test.js', 'utf8');
if (/Math\.random|setTimeout/.test(test)) throw new Error('测试仍含非确定性等待');
if ((test.match(/assert\.(?:ok|strictEqual|equal)\s*\(/g) ?? []).length < 2 || !/nextDelayMs/.test(test)) throw new Error('测试缺少原有断言');
execFileSync(process.execPath, ['--test', 'scheduler.test.js'], {stdio: 'inherit'});
execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {nextDelayMs} from './scheduler.js'; let delay = 1; for (let i = 0; i < 20; i++) delay = nextDelayMs(delay); assert.ok(delay <= 10000); assert.ok(nextDelayMs(100) > 100);"], {stdio: 'inherit'});
