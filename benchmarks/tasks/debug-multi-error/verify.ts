import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
execFileSync('npm', ['test'], {stdio: 'inherit'});
const source = readFileSync('src/calc.js', 'utf8');
// 防止把循环变量改回错误的 number；正确写法是 for (const n of numbers)。
if (/for\s*\(const\s+number\s+of/.test(source)) throw new Error('仍残留错误的 number 引用');
