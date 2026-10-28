/** 为用户消息保留界面显示文本，使模型实际输入可以安全持久化为展开后的正文。 */
export const messageDisplayContentMigration = {version: 5, sql: `
  ALTER TABLE messages ADD COLUMN display_content TEXT NULL;
`} as const;
