import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {runMigrations} from '../../../src/storage/migrations/index.js';
import {initialMigration} from '../../../src/storage/migrations/001-initial.js';
import {toolCallsMigration} from '../../../src/storage/migrations/002-tool-calls.js';
import {agentLoopMigration} from '../../../src/storage/migrations/003-agent-loop.js';
import type {MigrationDatabase} from '../../../src/storage/migrations/index.js';

describe('runMigrations', () => {
  it('从版本 3 升级保留旧消息和无所有者的运行', () => {
    const database = new DatabaseSync(':memory:');
    for (const migration of [initialMigration, toolCallsMigration, agentLoopMigration]) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(migration.version, 1);
    }
    database.exec("INSERT INTO sessions(id,profile_name,title,created_at,updated_at) VALUES('s','p','title',1,1)");
    database.exec("INSERT INTO messages(id,session_id,role,content,thinking,status,created_at,updated_at) VALUES('m','s','user','历史','','completed',1,1)");
    database.exec("INSERT INTO agent_runs(id,session_id,user_message_id,mode,status,started_at,updated_at) VALUES('r','s','m','execute','running',1,1)");
    runMigrations(database as unknown as MigrationDatabase);
    expect(database.prepare('SELECT content FROM messages WHERE id=?').get('m')).toMatchObject({content: '历史'});
    expect(database.prepare('SELECT status,owner_id,owner_pid FROM agent_runs WHERE id=?').get('r')).toMatchObject({status: 'running', owner_id: null, owner_pid: null});
    expect(database.prepare('SELECT count(*) AS n FROM context_checkpoints').get()).toMatchObject({n: 0});
    database.close();
  });

  it('创建 schema 并可重复调用', () => {
    const database = new DatabaseSync(':memory:');
    runMigrations(database as unknown as MigrationDatabase);
    runMigrations(database as unknown as MigrationDatabase);
    const rows = database.prepare('SELECT version FROM schema_migrations').all();
    // 重复初始化不得重复应用迁移。
    expect(rows).toEqual([{version: 1}, {version: 2}, {version: 3}, {version: 4}]);
    expect(() => database.prepare(`INSERT INTO messages(id,session_id,role,content,thinking,status,created_at,updated_at) VALUES ('x','missing','bad','','','bad',1,1)`).run()).toThrow();
    const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{name: string}>;
    expect(sessionColumns.map(column => column.name)).toEqual(expect.arrayContaining(['agent_mode', 'latest_plan_message_id']));
    database.close();
  });
});
