import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {SessionRepository} from '../../../src/storage/repository.js';

describe('SessionRepository', () => {
  it('按 profile 隔离并按更新时间排序', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bitori-repository-'));
    try {
      const repository = new SessionRepository(join(root, 'db.sqlite'));
      await repository.initialize();
      const first = await repository.createSession('a');
      const second = await repository.createSession('b');
      expect((await repository.listSessions('a')).map(item => item.id)).toEqual([first.id]);
      expect((await repository.listSessions('b')).map(item => item.id)).toEqual([second.id]);
      await repository.close();
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});
