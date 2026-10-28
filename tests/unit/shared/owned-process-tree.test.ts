import {ChildProcess, spawn} from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {OwnedProcessTree} from '../../../src/shared/owned-process-tree.js';

// Windows 无法在 Linux 上动态验收，这里只模拟系统进程 API 的时序与失败。
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return {...original, spawn: vi.fn()};
});

type MockChild = ChildProcessWithoutNullStreams & {killMock: ReturnType<typeof vi.fn>};

function childProcess(pid: number): MockChild {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const killMock = vi.fn(() => true);
  return Object.assign(new ChildProcess(), {
    pid, stdin, stdout, stderr, kill: killMock, killMock,
    stdio: [stdin, stdout, stderr, null, null] satisfies ChildProcessWithoutNullStreams['stdio'],
  });
}

function closeChild(child: ChildProcessWithoutNullStreams): void {
  Object.defineProperty(child, 'exitCode', {configurable: true, value: 0});
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
}

describe('OwnedProcessTree Windows 时序', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('process', {...process, platform: 'win32'});
    vi.mocked(spawn).mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('先等待 taskkill 整树终止，不先 kill 父进程，并复用关闭 Promise', async () => {
    const child = childProcess(12345); const killer = childProcess(12346);
    const childKill = child.killMock;
    vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const tree = new OwnedProcessTree('fixture', [], {cwd: '.'});
    const closing = tree.close();
    expect(tree.close()).toBe(closing);
    expect(spawn).toHaveBeenLastCalledWith('taskkill.exe', ['/PID', '12345', '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    expect(childKill).not.toHaveBeenCalled();
    killer.emit('exit', 0, null);
    closeChild(child);
    await closing;
    expect(childKill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['exit', 'error', 'timeout'])('taskkill %s 失败被报告，之后才兜底终止父进程', async mode => {
    const child = childProcess(12345); const killer = childProcess(12346);
    const childKill = child.killMock; const killerKill = killer.killMock;
    vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const tree = new OwnedProcessTree('fixture', [], {cwd: '.'});
    const closing = tree.close();
    const rejection = expect(closing).rejects.toThrow(/taskkill|超时/);
    expect(childKill).not.toHaveBeenCalled();
    if (mode === 'exit') killer.emit('exit', 5, null);
    else if (mode === 'error') killer.emit('error', new Error('taskkill missing'));
    else await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    expect(childKill).toHaveBeenCalledOnce();
    if (mode === 'timeout') expect(killerKill).toHaveBeenCalledOnce();
    closeChild(child);
    await rejection;
    expect(child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('整树命令成功但管道未关闭时仍有最终期限', async () => {
    const child = childProcess(12345); const killer = childProcess(12346);
    vi.mocked(spawn).mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const tree = new OwnedProcessTree('fixture', [], {cwd: '.'});
    const closing = tree.close();
    const rejection = expect(closing).rejects.toThrow('输出管道未在期限内关闭');
    killer.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('父 PID 已退出时不冒险杀可能复用的 PID，报告持管道失败且有界返回', async () => {
    const child = childProcess(12345);
    const childKill = child.killMock;
    vi.mocked(spawn).mockReturnValueOnce(child);
    const tree = new OwnedProcessTree('fixture', [], {cwd: '.'});
    Object.defineProperty(child, 'exitCode', {configurable: true, value: 0});
    child.emit('exit', 0, null);
    const closing = tree.close();
    const rejection = expect(closing).rejects.toThrow('无法再安全按父 PID');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
    expect(childKill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
