import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
execFileSync('npm', ['test'], {stdio: 'inherit'});
const test = readFileSync('scheduler.test.js', 'utf8');
if (/Math\.random|setTimeout/.test(test)) throw new Error('测试仍含非确定性等待');
