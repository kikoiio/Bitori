import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** 使用 harness 中的原始资产核对工作区，避免通过改写脚本或测试伪造通过。 */
export function verifyTestAssets(taskDir: string, tests: string[]): void {
  for (const path of ['package.json', ...tests]) {
    const original = readFileSync(join(taskDir, 'workspace', path));
    const actual = readFileSync(path);
    if (!actual.equals(original)) throw new Error(`不应修改 ${path}`);
  }
  execFileSync(process.execPath, ['--test', ...tests], {stdio: 'inherit'});
}
