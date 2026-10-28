import {OwnedProcessTree} from '../../shared/owned-process-tree.js';
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

export class RunCommandTool implements Tool<{command: string}> {
  // 与系统提示双重强化「优先使用专用工具」规则。
  readonly name = 'run_command'; readonly description = IS_WINDOWS ? '从当前工作区执行 PowerShell 命令；能用 read_file、write_file、edit_file、find_files、search_text 完成的操作优先使用专用工具' : '从当前工作区执行 bash 命令；能用 read_file、write_file、edit_file、find_files、search_text 完成的操作优先使用专用工具'; readonly effect = 'command' as const;
  readonly inputSchema = z.toJSONSchema(schema, {io: 'input'});
  parseArguments(input: unknown) { return schema.parse(input); }
  async execute(args: {command: string}, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.signal.aborted) return {status: 'interrupted', error: {code: 'interrupted', message: '命令已取消', retryable: false}};
    return new Promise(resolve => {
      const tree = IS_WINDOWS
        ? new OwnedProcessTree('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command], {cwd: context.workspaceRoot})
        : new OwnedProcessTree('/bin/bash', ['-c', args.command], {cwd: context.workspaceRoot});
      const child = tree.child;
      child.stdin.end();
      // 全程统计原始字节，但每条流最多保留上限加一个 UTF-8 码点，避免持续输出占满内存。
      const stdout = new BoundedOutput(context.limits.maxResultBytes); const stderr = new BoundedOutput(context.limits.maxResultBytes);
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      let settled = false;
      let cleaning = false;
      let stopReason: 'interrupted' | 'timeout' | undefined;
      let spawnError: Error | undefined;
      const finish = (cleanupError?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', abort);
        const out = stdout.text(); const err = stderr.text();
        const output = {exitCode: child.exitCode, stdout: out.text, stderr: err.text, stdoutBytes: stdout.originalBytes, stderrBytes: stderr.originalBytes};
        const outTruncation = {...out.truncation, truncated: stdout.originalBytes > out.truncation.returnedUnits, originalUnits: stdout.originalBytes};
        const errTruncation = {...err.truncation, truncated: stderr.originalBytes > err.truncation.returnedUnits, originalUnits: stderr.originalBytes};
        const truncation = outTruncation.truncated ? outTruncation : errTruncation;
        if (cleanupError) resolve({status: 'error', error: {code: 'internal_error', message: `命令进程树清理失败：${cleanupError.message}`, retryable: false}, partialOutput: output});
        else if (stopReason === 'timeout') resolve({status: 'timeout', error: {code: 'timeout', message: '命令执行超时', retryable: true}, partialOutput: output});
        else if (stopReason === 'interrupted') resolve({status: 'interrupted', error: {code: 'interrupted', message: '命令已取消', retryable: false}, partialOutput: output});
        else if (spawnError) resolve({status: 'error', error: {code: 'internal_error', message: spawnError.message, retryable: false}});
        else if (child.exitCode === 0) resolve({status: 'success', output, truncation});
        else resolve({status: 'error', error: {code: 'command_failed', message: `命令退出码为 ${String(child.exitCode)}`, retryable: false}, partialOutput: output, truncation});
      };
      const cleanup = (): void => {
        if (cleaning) return;
        cleaning = true;
        // 等待整组/整树收尾；helper 同时为继承管道设定最终期限。
        void tree.close().then(() => finish(), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      };
      const abort = (): void => { if (!settled) { stopReason ??= 'interrupted'; cleanup(); } };
      context.signal.addEventListener('abort', abort, {once: true});
      const timeout = setTimeout(() => { stopReason ??= 'timeout'; cleanup(); }, context.limits.timeoutMs);
      child.once('error', error => { spawnError = error; cleanup(); });
      // 父进程 exit 后即清理，不把后代持有管道的 close 当作唯一完成条件。
      child.once('exit', cleanup);
      if (context.signal.aborted) abort();
    });
  }
}
