import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");

export function createConversationStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS messages_conversation_id_id
      ON messages (conversation_id, id);
  `);

  const listStatement = database.prepare(`
    SELECT id, role, content, created_at AS createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id
  `);
  const insertStatement = database.prepare(`
    INSERT INTO messages (conversation_id, role, content)
    VALUES (?, ?, ?)
  `);
  const clearStatement = database.prepare(`
    DELETE FROM messages
    WHERE conversation_id = ?
  `);

  return {
    listMessages(conversationId) {
      return listStatement.all(conversationId);
    },

    appendExchange(conversationId, userContent, assistantContent) {
      database.exec("BEGIN IMMEDIATE");
      try {
        insertStatement.run(conversationId, "user", userContent);
        insertStatement.run(conversationId, "assistant", assistantContent);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    clear(conversationId) {
      clearStatement.run(conversationId);
    },

    close() {
      database.close();
    },
  };
}
