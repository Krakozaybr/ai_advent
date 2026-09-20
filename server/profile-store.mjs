import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");

export function createProfileStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      scope_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      expertise TEXT NOT NULL,
      style TEXT NOT NULL,
      format TEXT NOT NULL,
      constraints_text TEXT NOT NULL,
      language TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_id, id)
    );
  `);

  const insertStatement = database.prepare(`
    INSERT OR IGNORE INTO user_profiles (
      scope_id, id, name, expertise, style, format, constraints_text, language
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listStatement = database.prepare(`
    SELECT id, name, expertise, style, format,
      constraints_text AS constraints, language, updated_at AS updatedAt
    FROM user_profiles
    WHERE scope_id = ?
    ORDER BY id
  `);
  const getStatement = database.prepare(`
    SELECT id, name, expertise, style, format,
      constraints_text AS constraints, language, updated_at AS updatedAt
    FROM user_profiles
    WHERE scope_id = ? AND id = ?
  `);
  const updateStatement = database.prepare(`
    UPDATE user_profiles SET
      name = ?, expertise = ?, style = ?, format = ?, constraints_text = ?,
      language = ?, updated_at = CURRENT_TIMESTAMP
    WHERE scope_id = ? AND id = ?
  `);

  return {
    ensureDefaults(scopeId, profiles) {
      for (const profile of profiles) {
        insertStatement.run(
          scopeId,
          profile.id,
          profile.name,
          profile.expertise,
          profile.style,
          profile.format,
          profile.constraints,
          profile.language,
        );
      }
      return listStatement.all(scopeId);
    },

    list(scopeId) {
      return listStatement.all(scopeId);
    },

    get(scopeId, id) {
      return getStatement.get(scopeId, id) ?? null;
    },

    update(scopeId, id, profile) {
      const result = updateStatement.run(
        profile.name,
        profile.expertise,
        profile.style,
        profile.format,
        profile.constraints,
        profile.language,
        scopeId,
        id,
      );
      return result.changes > 0 ? getStatement.get(scopeId, id) : null;
    },

    close() {
      database.close();
    },
  };
}
