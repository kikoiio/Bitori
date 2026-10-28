import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

export const processTreeFixture = fileURLToPath(new URL('../fixtures/process-tree/launcher.ts', import.meta.url));

export async function fixturePid(path: string): Promise<number> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const value = Number(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(25);
  }
  throw new Error('进程树 fixture 未就绪');
}

export async function isFixtureRunning(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    // 容器的 PID 1 不一定及时回收孤儿僵尸；僵尸已经不能执行代码或持有管道。
    try { return !(await readFile(`/proc/${String(pid)}/stat`, 'utf8')).includes(') Z'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function cleanupFixture(pid: number): Promise<void> {
  if (pid > 0 && await isFixtureRunning(pid)) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  }
}
