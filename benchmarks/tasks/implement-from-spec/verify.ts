import {readFileSync} from 'node:fs';
import {verifyTestAssets} from '../../verify-test-assets.js';
verifyTestAssets(import.meta.dirname, ['stack.test.js']);
if (!/class\s+Stack/.test(readFileSync('stack.js', 'utf8'))) throw new Error('必须导出 Stack 类');
