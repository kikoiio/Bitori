import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {verifyTestAssets} from '../../verify-test-assets.js';
verifyTestAssets(import.meta.dirname, ['app.test.js']);
if (/\bbadlyNamedAdd\b/.test(readFileSync('app.js', 'utf8')) || /\bbadlyNamedAdd\b/.test(readFileSync('utils/calc.js', 'utf8'))) throw new Error('仍有旧名称');
execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import * as calc from './utils/calc.js'; assert.equal(typeof calc.add, 'function'); assert.equal(calc.add(2, 4), 6); assert.equal('badlyNamedAdd' in calc, false)"], {stdio: 'inherit'});
