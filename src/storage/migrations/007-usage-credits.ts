/** Qoder 等协议只上报 credits；与 tokens 并存，NULL 表示未上报而不是零。 */
export const usageCreditsMigration = {version: 7, sql: `
  ALTER TABLE messages ADD COLUMN credits REAL NULL;
  ALTER TABLE agent_runs ADD COLUMN credits REAL NULL;
`} as const;
