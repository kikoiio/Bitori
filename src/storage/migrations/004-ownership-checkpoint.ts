export const ownershipCheckpointMigration = {version: 4, sql: `
  ALTER TABLE messages ADD COLUMN owner_id TEXT;
  ALTER TABLE messages ADD COLUMN owner_pid INTEGER;
  ALTER TABLE agent_runs ADD COLUMN owner_id TEXT;
  ALTER TABLE agent_runs ADD COLUMN owner_pid INTEGER;
  CREATE TABLE context_checkpoints (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    boundary_message_id TEXT NOT NULL REFERENCES messages(id),
    items_json TEXT NOT NULL
  );
`} as const;
