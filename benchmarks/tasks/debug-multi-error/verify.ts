import {readFileSync} from 'node:fs';
import {verifyTestAssets} from '../../verify-test-assets.js';
verifyTestAssets(import.meta.dirname, ['src/calc.test.js']);
if (/for\s*\(const\s+number\s+of/.test(readFileSync('src/calc.js', 'utf8'))) throw new Error('仍残留错误的 number 引用');
