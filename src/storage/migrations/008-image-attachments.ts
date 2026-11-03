export const imageAttachmentsMigration = {version: 8, sql: `
  ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
`} as const;
