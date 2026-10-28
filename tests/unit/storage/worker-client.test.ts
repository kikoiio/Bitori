import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {StorageWorkerClient} from '../../../src/storage/worker-client.js';

describe('StorageWorkerClient', () => {
  it('Worker 零退出会拒绝等待和后续请求', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-worker-exit-'));
    try {
      const workerPath = join(root, 'exit.mjs');
      writeFileSync(workerPath, 'process.exit(0)');
      const worker = new StorageWorkerClient(':memory:', pathToFileURL(workerPath));
      await expect(worker.request({type: 'initialize'})).rejects.toThrow('意外退出');
      await expect(worker.request({type: 'initialize'})).rejects.toThrow('关闭');
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
