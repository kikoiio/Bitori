import {afterEach, describe, expect, it} from 'vitest';
import {realpath} from 'node:fs/promises';
import {RunCommandTool} from '../../../src/tools/implementations/run-command.js';
import {TemporaryWorkspace} from '../../helpers/temporary-workspace.js';

const items: TemporaryWorkspace[] = []; afterEach(async () => Promise.all(items.splice(0).map(item => item.cleanup())));
describe('RunCommandTool', () => {
  const IS_WINDOWS = process.platform === 'win32';
  const cwd = IS_WINDOWS ? '(Get-Location).Path' : 'pwd';
  const unicodeError = IS_WINDOWS ? `[Console]::Error.WriteLine('错误')` : `printf '错误\\n' >&2`;
  const beforeExit = IS_WINDOWS ? `Write-Output 'before'; exit 7` : `printf 'before\\n'; exit 7`;
  const repeat = IS_WINDOWS ? `'x' * 1000` : `printf 'x%.0s' {1..1000}`;
  const largeOutput = IS_WINDOWS ? `[Console]::Out.Write('x' * 2000000)` : `printf 'x%.0s' $(seq 1 2000000)`;
  const sleep = IS_WINDOWS ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  it('从工作区执行并捕获 Unicode stdout/stderr', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const result = await new RunCommandTool().execute({command: IS_WINDOWS ? `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cwd}; ${unicodeError}` : `${cwd}; ${unicodeError}`}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 5_000, maxResultBytes: 65_536, maxMatches: 500}}); expect(result).toMatchObject({status: 'success', output: {exitCode: 0}}); if (result.status !== 'success') return; expect(String(result.output.stderr)).toContain('错误'); expect((await realpath(w.root)).toLowerCase()).toContain(String(result.output.stdout).trim().toLowerCase()); });
  it('非零退出返回 command_failed 和部分输出', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const result = await new RunCommandTool().execute({command: beforeExit}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 5_000, maxResultBytes: 65_536, maxMatches: 500}}); expect(result).toMatchObject({status: 'error', error: {code: 'command_failed'}, partialOutput: {exitCode: 7}}); expect(result.status === 'error' && String(result.partialOutput?.stdout)).toContain('before'); });
  it('持续输出只保留固定上限并报告原始规模', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const result = await new RunCommandTool().execute({command: IS_WINDOWS ? repeat : `printf 'x%.0s' $(seq 1 1000)`}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 5_000, maxResultBytes: 32, maxMatches: 500}}); expect(result).toMatchObject({status: 'success', truncation: {truncated: true, returnedUnits: 32}}); expect(result.status === 'success' && Buffer.byteLength(String(result.output.stdout))).toBeLessThanOrEqual(32); });
  it('多兆输出仍只保留固定上限并统计完整规模', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const result = await new RunCommandTool().execute({command: largeOutput}, {workspaceRoot: w.root, signal: new AbortController().signal, limits: {timeoutMs: 10_000, maxResultBytes: 1024, maxMatches: 500}}); expect(result).toMatchObject({status: 'success'}); if (result.status !== 'success') return; expect(result.output.stdoutBytes).toBeGreaterThanOrEqual(2_000_000); expect(result.truncation?.originalUnits).toBe(result.output.stdoutBytes); }, 15_000);
  it('取消后收敛为 interrupted', async () => { const w = await TemporaryWorkspace.create(); items.push(w); const abort = new AbortController(); const pending = new RunCommandTool().execute({command: sleep}, {workspaceRoot: w.root, signal: abort.signal, limits: {timeoutMs: 60_000, maxResultBytes: 100, maxMatches: 500}}); setTimeout(() => abort.abort(), 100); await expect(pending).resolves.toMatchObject({status: 'interrupted', error: {code: 'interrupted'}}); }, 10_000);
  it('Schema 拒绝 cwd、timeout 和空命令', () => { const tool = new RunCommandTool(); expect(() => tool.parseArguments({command: ''})).toThrow(); expect(() => tool.parseArguments({command: 'echo x', cwd: '..'})).toThrow(); });
});
