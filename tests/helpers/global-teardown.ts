import {readdirSync, statSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * 全局测试收尾：清理历史测试运行遗留的 `/tmp/bitori-*` 目录。
 * 只删除超过 1 小时未被修改的目录——正常运行的测试（含并行进程）不会命中；
 * 失败或被中断的运行留下的残留由下一次 `npm test` 收走。
 * 单文件（如其他任务的日志）一律不动。
 */
export default function globalTeardown(): () => void {
  return () => {
    cleanup();
  };
}

function cleanup(): void {
  const cutoff = Date.now() - 3_600_000;
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('bitori-')) continue;
    const path = join(tmpdir(), entry);
    try {
      if (!statSync(path).isDirectory()) continue;
      if (statSync(path).mtimeMs < cutoff) rmSync(path, {recursive: true, force: true});
    } catch {
      // 并行进程恰好删除/重建时跳过，下次运行再清。
    }
  }
}
