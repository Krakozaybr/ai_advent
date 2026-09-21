import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");

const LAYER_TABLES = {
  shortTerm: "memory_short_term_items",
  working: "memory_working_items",
  longTerm: "memory_long_term_items",
};

function assertLayer(layer) {
  if (!Object.hasOwn(LAYER_TABLES, layer)) {
    throw new Error(`Неизвестный слой памяти: ${layer}`);
  }
}

export function createMemoryStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_short_term_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS memory_short_term_messages_scope_id_id
      ON memory_short_term_messages (scope_id, id);

    CREATE TABLE IF NOT EXISTS memory_short_term_items (
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_id, key)
    );

    CREATE TABLE IF NOT EXISTS memory_working_items (
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_id, key)
    );

    CREATE TABLE IF NOT EXISTS memory_long_term_items (
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_id, key)
    );
  `);

  const listMessagesStatement = database.prepare(`
    SELECT id, role, content, created_at AS createdAt
    FROM memory_short_term_messages
    WHERE scope_id = ?
    ORDER BY id
  `);
  const insertMessageStatement = database.prepare(`
    INSERT INTO memory_short_term_messages (scope_id, role, content)
    VALUES (?, ?, ?)
  `);
  const clearMessagesStatement = database.prepare(`
    DELETE FROM memory_short_term_messages
    WHERE scope_id = ?
  `);

  const statements = Object.fromEntries(
    Object.entries(LAYER_TABLES).map(([layer, table]) => [
      layer,
      {
        list: database.prepare(`
          SELECT key, value, updated_at AS updatedAt
          FROM ${table}
          WHERE scope_id = ?
          ORDER BY key
        `),
        upsert: database.prepare(`
          INSERT INTO ${table} (scope_id, key, value)
          VALUES (?, ?, ?)
          ON CONFLICT (scope_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        `),
        delete: database.prepare(`
          DELETE FROM ${table}
          WHERE scope_id = ? AND key = ?
        `),
        clear: database.prepare(`
          DELETE FROM ${table}
          WHERE scope_id = ?
        `),
      },
    ]),
  );

  function listItems(scopeId, layer) {
    assertLayer(layer);
    return statements[layer].list.all(scopeId);
  }

  return {
    getState(scopeId) {
      return {
        messages: listMessagesStatement.all(scopeId),
        layers: {
          shortTerm: listItems(scopeId, "shortTerm"),
          working: listItems(scopeId, "working"),
          longTerm: listItems(scopeId, "longTerm"),
        },
      };
    },

    upsertItem(scopeId, layer, key, value) {
      assertLayer(layer);
      statements[layer].upsert.run(scopeId, key, value);
      return listItems(scopeId, layer);
    },

    deleteItem(scopeId, layer, key) {
      assertLayer(layer);
      statements[layer].delete.run(scopeId, key);
      return listItems(scopeId, layer);
    },

    clearLayer(scopeId, layer) {
      assertLayer(layer);
      database.exec("BEGIN IMMEDIATE");
      try {
        if (layer === "shortTerm") {
          clearMessagesStatement.run(scopeId);
        }
        statements[layer].clear.run(scopeId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    appendExchange(scopeId, userContent, assistantContent) {
      database.exec("BEGIN IMMEDIATE");
      try {
        insertMessageStatement.run(scopeId, "user", userContent);
        insertMessageStatement.run(scopeId, "assistant", assistantContent);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    clear(scopeId) {
      database.exec("BEGIN IMMEDIATE");
      try {
        clearMessagesStatement.run(scopeId);
        for (const layer of Object.keys(LAYER_TABLES)) {
          statements[layer].clear.run(scopeId);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    close() {
      database.close();
    },
  };
}
