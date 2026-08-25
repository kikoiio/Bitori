/** [s02] 工具调用独立持久化，恢复时可精确区分审批与执行终态。 */
export const toolCallsMigration = {version: 2, sql: `
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    assistant_message_id TEXT NOT NULL REFERENCES messages(id),
    provider_call_id TEXT NULL,
    position INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    approval_status TEXT NOT NULL CHECK(approval_status IN ('not_required','pending','approved','denied')),
    execution_status TEXT NOT NULL CHECK(execution_status IN ('queued','running','succeeded','failed','timed_out','skipped','interrupted')),
    result_json TEXT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tool_calls_session_position ON tool_calls(session_id, assistant_message_id, position);
`} as const;
