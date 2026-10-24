import {now} from '../../shared/ids.js';
import {initialMigration} from './001-initial.js';
import {toolCallsMigration} from './002-tool-calls.js';
import {agentLoopMigration} from './003-agent-loop.js';

export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [initialMigration, toolCallsMigration, agentLoopMigration];

/** [s01] 只描述迁移器需要的最小数据库能力，避免它绑定到具体 SQLite 类。 */
export interface MigrationDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (...parameters: unknown[]) => unknown;
    run: (...parameters: unknown[]) => unknown;
  };
}

export function runMigrations(database: MigrationDatabase): void {
  // [s01] 先确保版本表存在；首次数据库和旧数据库都能执行这一步。
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const applied = database.prepare('SELECT version FROM schema_migrations').all() as Array<{version: number}>;
  const versions = new Set(applied.map(row => row.version));
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    // [s01] 每个迁移和其版本记录在同一事务中：要么全部成功，要么全部回滚。
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
