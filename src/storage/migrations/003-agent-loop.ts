/** [s03] Agent Loop、会话模式和逐迭代关联的持久化结构。 */
export const agentLoopMigration = {version: 3, sql: `
  ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'execute' CHECK(agent_mode IN ('plan','execute'));
  ALTER TABLE sessions ADD COLUMN latest_plan_message_id TEXT NULL REFERENCES messages(id);
  ALTER TABLE messages ADD COLUMN agent_run_id TEXT NULL;
  ALTER TABLE messages ADD COLUMN iteration INTEGER NULL;
  ALTER TABLE tool_calls ADD COLUMN agent_run_id TEXT NULL;
  ALTER TABLE tool_calls ADD COLUMN arguments_text TEXT NULL;
  UPDATE tool_calls SET arguments_text = arguments_json WHERE arguments_text IS NULL;
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    user_message_id TEXT NOT NULL REFERENCES messages(id),
    mode TEXT NOT NULL CHECK(mode IN ('plan','execute')),
    status TEXT NOT NULL CHECK(status IN ('running','completed','stopped','cancelled','failed','interrupted')),
    stop_reason TEXT NULL,
    iteration_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX agent_runs_session_started ON agent_runs(session_id, started_at ASC);
  CREATE INDEX messages_agent_iteration ON messages(agent_run_id, iteration);
  CREATE INDEX tool_calls_agent_run ON tool_calls(agent_run_id);
`} as const;
