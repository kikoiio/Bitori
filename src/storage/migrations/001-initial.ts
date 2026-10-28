/**
 * 第 1 版数据库结构。
 * SQL 作为数据导出，真正的事务和版本记录由 migrations/index.ts 统一负责。
 */
export const initialMigration = {
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      profile_name TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      thinking TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('streaming', 'completed', 'cancelled', 'failed')),
      error_code TEXT NULL,
      error_message TEXT NULL,
      input_tokens INTEGER NULL,
      output_tokens INTEGER NULL,
      -- 某些 Provider 的结构化重放状态以 JSON 文本保存；普通消息为 NULL。
      provider_state TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX sessions_profile_updated ON sessions(profile_name, updated_at DESC);
    CREATE INDEX messages_session_created ON messages(session_id, created_at ASC);
  `,
// as const 让 version 保持字面量 1，并把整个对象视为只读配置。
} as const;
