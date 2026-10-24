import {execFileSync} from 'node:child_process';
execFileSync('npm', ['test'], {stdio: 'inherit'});
const source = (await import('node:fs')).readFileSync('src/calc.js', 'utf8');
if (source.includes('number') && !source.includes('for (const number of')) throw new Error('仍残留错误的 number 引用');
