import {execFileSync} from 'node:child_process';
execFileSync('npm', ['test'], {stdio: 'inherit'});
const source = (await import('node:fs')).readFileSync('stack.js', 'utf8');
if (!/class\s+Stack/.test(source)) throw new Error('必须导出 Stack 类');
if (source.includes('stack.test.js')) throw new Error('不应修改测试文件');
