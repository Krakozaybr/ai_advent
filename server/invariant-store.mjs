import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");

export function createInvariantStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_invariants (
      scope_id TEXT NOT NULL,
      id TEXT NOT NULL,
      category TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      forbidden_terms_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_id, id)
    );
  `);

  const insertDefault = database.prepare(`
    INSERT OR IGNORE INTO task_invariants (
      scope_id, id, category, rule_text, forbidden_terms_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const insertCustom = database.prepare(`
    INSERT INTO task_invariants (
      scope_id, id, category, rule_text, forbidden_terms_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const listStatement = database.prepare(`
    SELECT id, category, rule_text AS rule, forbidden_terms_json AS forbiddenTerms,
      created_at AS createdAt
    FROM task_invariants WHERE scope_id = ? ORDER BY created_at, id
  `);
  const deleteStatement = database.prepare(`
    DELETE FROM task_invariants WHERE scope_id = ? AND id = ?
  `);

  function parse(row) {
    return { ...row, forbiddenTerms: JSON.parse(row.forbiddenTerms) };
  }

  return {
    ensureDefaults(scopeId, invariants) {
      for (const invariant of invariants) {
        insertDefault.run(
          scopeId,
          invariant.id,
          invariant.category,
          invariant.rule,
          JSON.stringify(invariant.forbiddenTerms),
        );
      }
      return this.list(scopeId);
    },

    list(scopeId) {
      return listStatement.all(scopeId).map(parse);
    },

    add(scopeId, { category, rule, forbiddenTerms }) {
      const id = randomUUID();
      insertCustom.run(scopeId, id, category, rule, JSON.stringify(forbiddenTerms));
      return this.list(scopeId);
    },

    delete(scopeId, id) {
      deleteStatement.run(scopeId, id);
      return this.list(scopeId);
    },

    close() {
      database.close();
    },
  };
}
