import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

interface OwnedProcessOptions {cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean}
interface CloseOptions {stdinGraceMs?: number}

/** 只管理本实例创建的进程；POSIX 必须从启动时就拥有独立进程组。 */
export class OwnedProcessTree {
  readonly child: ChildProcessWithoutNullStreams;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(command: string, args: string[], options: OwnedProcessOptions) {
    this.child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.once('close', () => { this.#closed = true; });
    // 对端可在 end/write 前退出，不能让异步 EPIPE 成为未处理事件。
    this.child.stdin.on('error', () => undefined);
  }

  close(options: CloseOptions = {}): Promise<void> {
    this.#closing ??= this.#close(options.stdinGraceMs ?? 0);
    return this.#closing;
  }

  async #close(stdinGraceMs: number): Promise<void> {
    const child = this.child;
    const pid = child.pid;
    let closed: boolean;
    try {
      child.stdin.end();
      if (stdinGraceMs > 0) await this.#waitForClose(stdinGraceMs);
      if (pid !== undefined) {
        if (process.platform === 'win32') await this.#terminateWindowsTree(pid);
        else {
          this.#signalGroup(pid, 'SIGTERM');
          const deadline = Date.now() + 1_000;
          // close 只说明管道已关，不能证明整个进程组都退出；反之父进程退出也不撤销组归属。
          while (this.#groupExists(pid) && Date.now() < deadline) await delay(25);
          this.#signalGroup(pid, 'SIGKILL');
        }
      }
    } finally {
      closed = await this.#waitForClose(1_000);
      // 脱离进程组或异常继承的管道也不能无限阻塞调用者。
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (!closed) throw new Error('进程树终止后输出管道未在期限内关闭');
  }

  #signalGroup(pid: number, signal: NodeJS.Signals): void {
    try { process.kill(-pid, signal); }
    catch (error) { if (!isMissingProcess(error)) throw error; }
  }

  #groupExists(pid: number): boolean {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if (isMissingProcess(error)) return false; throw error; }
  }

  async #terminateWindowsTree(pid: number): Promise<void> {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      // 父 PID 退出后可能被系统复用，不能再按旧 PID 杀树。
      if (await this.#waitForClose(1_000)) return;
      throw new Error('Windows 启动器已退出但后代仍持有管道，无法再安全按父 PID 终止进程树');
    }
    // 必须在父进程仍存活时遍历整树，并等待 taskkill 结果，绝不先 child.kill()。
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    const error = await new Promise<Error | undefined>(resolve => {
      let settled = false;
      const finish = (result?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(new Error('Windows 进程树终止超时'));
      }, 2_000);
      killer.once('error', finish);
      killer.once('exit', (code, signal) => finish(code === 0 ? undefined : new Error(`taskkill 失败（code=${String(code)}, signal=${String(signal)}）`)));
    });
    if (error) {
      // 整树操作完成或失败之后才允许父进程兜底；失败不能伪报清理成功。
      if (child.exitCode === null && child.signalCode === null) child.kill();
      throw error;
    }
  }

  #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (closed: boolean): void => {
        clearTimeout(timer);
        this.child.removeListener('close', onClose);
        resolve(closed);
      };
      const onClose = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once('close', onClose);
    });
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
