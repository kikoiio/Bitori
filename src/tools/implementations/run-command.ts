import {spawn} from 'node:child_process';
import {z} from 'zod';
import {truncateUtf8} from '../limits.js';
import type {Tool, ToolContext, ToolExecutionResult} from '../types.js';

const schema = z.object({command: z.string().trim().min(1)}).strict();
const IS_WINDOWS = process.platform === 'win32';

class BoundedOutput {
  readonly #chunks: Buffer[] = [];
  #retainedBytes = 0;
  originalBytes = 0;
  constructor(readonly maximumBytes: number) {}
  add(chunk: Buffer): void { this.originalBytes += chunk.length; const room = this.maximumBytes + 4 - this.#retainedBytes; if (room > 0) { const retained = chunk.subarray(0, room); this.#chunks.push(retained); this.#retainedBytes += retained.length; } }
  text(): ReturnType<typeof truncateUtf8> { return truncateUtf8(Buffer.concat(this.#chunks).toString('utf8'), this.maximumBytes); }
}

/* [s02 旧实现，s14 跨平台替换] 命令固定由 PowerShell 执行。 */
export class RunCommandTool implements Tool<{command: string}> {
  /* [s02 旧实现，s04 替换] readonly description = '从当前工作区执行 PowerShell 命令' */
  // [s04] 与系统提示双重强化「优先使用专用工具」规则。
  readonly name = 'run_command'; readonly description = IS_WINDOWS ? '从当前工作区执行 PowerShell 命令；能用 read_file、write_file、edit_file、find_files、search_text 完成的操作优先使用专用工具' : '从当前工作区执行 bash 命令；能用 read_file、write_file、edit_file、find_files、search_text 完成的操作优先使用专用工具'; readonly effect = 'command' as const;
  readonly inputSchema = {type: 'object', properties: {command: {type: 'string'}}, required: ['command'], additionalProperties: false};
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {command: string}, context: ToolContext): Promise<ToolExecutionResult> {
    return new Promise(resolve => {
      const child = IS_WINDOWS
        ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command], {cwd: context.workspaceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']})
        : spawn('/bin/bash', ['-c', args.command], {cwd: context.workspaceRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      // [s02] 全程统计原始字节，但每条流最多保留上限加一个 UTF-8 码点，避免持续输出占满内存。
      const stdout = new BoundedOutput(context.limits.maxResultBytes); const stderr = new BoundedOutput(context.limits.maxResultBytes);
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      let settled = false;
      const finish = (result: ToolExecutionResult): void => { if (settled) return; settled = true; resolve(result); };
      const snapshot = () => { const out = stdout.text(); const err = stderr.text(); return {exitCode: null, stdout: out.text, stderr: err.text, stdoutBytes: stdout.originalBytes, stderrBytes: stderr.originalBytes}; };
      // [s05] 取消先立即收敛工具终态，再异步终止 PowerShell 进程树；close 事件只负责补充正常终态。
      const stop = () => {
        const pid = child.pid;
        if (IS_WINDOWS) { child.kill(); if (pid) spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {windowsHide: true}).once('close', () => undefined); }
        else if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
        const output = snapshot(); finish({status: 'interrupted', error: {code: 'interrupted', message: '命令已取消', retryable: false}, partialOutput: output});
      };
      context.signal.addEventListener('abort', stop, {once: true});
      const timeout = setTimeout(stop, context.limits.timeoutMs);
      child.once('error', error => finish({status: 'error', error: {code: 'internal_error', message: error.message, retryable: false}}));
      child.once('close', exitCode => {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', stop);
        const out = stdout.text(); const err = stderr.text();
        const output = {exitCode, stdout: out.text, stderr: err.text, stdoutBytes: stdout.originalBytes, stderrBytes: stderr.originalBytes};
        const outTruncation = {...out.truncation, truncated: stdout.originalBytes > out.truncation.returnedUnits, originalUnits: stdout.originalBytes};
        const errTruncation = {...err.truncation, truncated: stderr.originalBytes > err.truncation.returnedUnits, originalUnits: stderr.originalBytes};
        if (context.signal.aborted) finish({status: 'interrupted', error: {code: 'interrupted', message: '命令已取消', retryable: false}, partialOutput: output});
        else if (exitCode === 0) finish({status: 'success', output, truncation: outTruncation.truncated ? outTruncation : errTruncation});
        else finish({status: 'error', error: {code: 'command_failed', message: `命令退出码为 ${String(exitCode)}`, retryable: false}, partialOutput: output, truncation: outTruncation.truncated ? outTruncation : errTruncation});
      });
    });
  }
}
