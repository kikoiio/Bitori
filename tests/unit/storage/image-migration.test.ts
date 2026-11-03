import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {migrations, runMigrations} from '../../../src/storage/migrations/index.js';

describe('image attachment database upgrade', () => {
  it('keeps pre-image history and gives old messages an empty attachment list', () => {
    const database = new DatabaseSync(':memory:');
    try {
      for (const migration of migrations.filter(migration => migration.version < 8)) {
        database.exec(migration.sql);
        database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,0)').run(migration.version);
      }
      database.exec("INSERT INTO sessions(id,profile_name,title,created_at,updated_at) VALUES('s','p','old session',1,1)");
      database.exec("INSERT INTO messages(id,session_id,role,content,thinking,status,created_at,updated_at) VALUES('m','s','user','old text','','completed',1,1)");
      runMigrations(database);
      expect(database.prepare('SELECT content,attachments_json FROM messages WHERE id=?').get('m')).toMatchObject({content: 'old text', attachments_json: '[]'});
      runMigrations(database);
      expect(database.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({count: 1});
    } finally {
      database.close();
    }
  });
});
