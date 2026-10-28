import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {runMigrations} from '../../../src/storage/migrations/index.js';
import type {MigrationDatabase} from '../../../src/storage/migrations/index.js';

describe('runMigrations', () => {
  it('创建 schema 并可重复调用', () => {
    const database = new DatabaseSync(':memory:');
    runMigrations(database as unknown as MigrationDatabase);
    runMigrations(database as unknown as MigrationDatabase);
    const rows = database.prepare('SELECT version FROM schema_migrations').all();
    // Agent Loop 数据结构是版本 3；重复初始化仍不得重复应用旧迁移。
    expect(rows).toEqual([{version: 1}, {version: 2}, {version: 3}]);
    expect(() => database.prepare(`INSERT INTO messages(id,session_id,role,content,thinking,status,created_at,updated_at) VALUES ('x','missing','bad','','','bad',1,1)`).run()).toThrow();
    const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{name: string}>;
    expect(sessionColumns.map(column => column.name)).toEqual(expect.arrayContaining(['agent_mode', 'latest_plan_message_id']));
    database.close();
  });
});
