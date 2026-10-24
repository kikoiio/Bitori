import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
execFileSync('npm', ['test'], {stdio: 'inherit'});
if (!/class\s+Stack/.test(readFileSync('stack.js', 'utf8'))) throw new Error('必须导出 Stack 类');
if (createHash('md5').update(readFileSync('stack.test.js')).digest('hex') !== 'f21d82e0fbf795fcc0fd9d2e109947da') throw new Error('不应修改测试文件');
