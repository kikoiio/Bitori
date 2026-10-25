import {readdirSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {getLogger} from '../shared/logger.js';

const logger = getLogger('trace');

/** [s15] 按文件修改时间清理超期 trace；只删除 `<uuid>.jsonl` 命名的文件。 */
export function cleanupExpiredTraces(directory: string, retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.jsonl$/.test(entry)) continue;
    try {
      if (statSync(join(directory, entry)).mtimeMs < cutoff) {
        unlinkSync(join(directory, entry));
        removed += 1;
      }
    } catch (error) {
      logger.debug('trace 清理失败', {entry, error: error instanceof Error ? error.message : String(error)});
    }
  }
  if (removed > 0) logger.info('已清理超期 trace', {removed, retentionDays});
  return removed;
}
