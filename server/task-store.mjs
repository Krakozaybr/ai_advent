import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");
const NEXT_PHASE = {
  planning: "execution",
  execution: "validation",
  validation: "done",
};

export function createTaskStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      scope_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('planning', 'execution', 'validation', 'done')),
      current_step TEXT NOT NULL,
      expected_action TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_phase TEXT,
      to_phase TEXT,
      details TEXT NOT NULL,
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS agent_task_events_scope_id_id
      ON agent_task_events (scope_id, id);
  `);

  const insertTask = database.prepare(`
    INSERT OR IGNORE INTO agent_tasks (
      scope_id, title, phase, current_step, expected_action, paused
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getTask = database.prepare(`
    SELECT scope_id AS scopeId, title, phase, current_step AS currentStep,
      expected_action AS expectedAction, paused, updated_at AS updatedAt
    FROM agent_tasks WHERE scope_id = ?
  `);
  const updateDetails = database.prepare(`
    UPDATE agent_tasks SET title = ?, current_step = ?, expected_action = ?,
      updated_at = CURRENT_TIMESTAMP WHERE scope_id = ?
  `);
  const updatePhase = database.prepare(`
    UPDATE agent_tasks SET phase = ?, current_step = ?, expected_action = ?,
      paused = 0, updated_at = CURRENT_TIMESTAMP WHERE scope_id = ?
  `);
  const updatePaused = database.prepare(`
    UPDATE agent_tasks SET paused = ?, updated_at = CURRENT_TIMESTAMP WHERE scope_id = ?
  `);
  const insertEvent = database.prepare(`
    INSERT INTO agent_task_events (
      scope_id, event_type, from_phase, to_phase, details, accepted
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listEvents = database.prepare(`
    SELECT id, event_type AS eventType, from_phase AS fromPhase,
      to_phase AS toPhase, details, accepted, created_at AS createdAt
    FROM agent_task_events WHERE scope_id = ? ORDER BY id DESC LIMIT 30
  `);
  const deleteEvents = database.prepare(`DELETE FROM agent_task_events WHERE scope_id = ?`);

  function normalizeTask(task) {
    return task ? { ...task, paused: Boolean(task.paused) } : null;
  }

  function log(scopeId, eventType, fromPhase, toPhase, details, accepted) {
    insertEvent.run(scopeId, eventType, fromPhase, toPhase, details, accepted ? 1 : 0);
  }

  return {
    ensure(scopeId, task) {
      insertTask.run(
        scopeId,
        task.title,
        task.phase,
        task.currentStep,
        task.expectedAction,
        task.paused ? 1 : 0,
      );
      return normalizeTask(getTask.get(scopeId));
    },

    getState(scopeId) {
      return {
        task: normalizeTask(getTask.get(scopeId)),
        events: listEvents.all(scopeId),
      };
    },

    update(scopeId, { title, currentStep, expectedAction }) {
      updateDetails.run(title, currentStep, expectedAction, scopeId);
      const task = normalizeTask(getTask.get(scopeId));
      log(scopeId, "details_updated", task.phase, task.phase, "Обновлены текущий шаг и ожидаемое действие.", true);
      return this.getState(scopeId);
    },

    advance(scopeId) {
      const task = normalizeTask(getTask.get(scopeId));
      const nextPhase = NEXT_PHASE[task.phase];
      if (task.paused) {
        log(scopeId, "advance", task.phase, nextPhase ?? null, "Сначала продолжите задачу после паузы.", false);
        return { ok: false, reason: "Задача на паузе. Сначала нажмите «Продолжить».", ...this.getState(scopeId) };
      }
      if (!nextPhase) {
        log(scopeId, "advance", task.phase, null, "Задача уже завершена.", false);
        return { ok: false, reason: "Задача уже находится в состоянии done.", ...this.getState(scopeId) };
      }
      const defaults = {
        execution: ["Выполнить утверждённый план", "Завершить реализацию"],
        validation: ["Проверить результат", "Зафиксировать результат проверки"],
        done: ["Работа завершена", "Дополнительных действий не ожидается"],
      };
      updatePhase.run(nextPhase, defaults[nextPhase][0], defaults[nextPhase][1], scopeId);
      log(scopeId, "advance", task.phase, nextPhase, `Переход ${task.phase} → ${nextPhase}.`, true);
      return { ok: true, ...this.getState(scopeId) };
    },

    setPaused(scopeId, paused) {
      const task = normalizeTask(getTask.get(scopeId));
      if (task.phase === "done") {
        log(scopeId, paused ? "pause" : "resume", task.phase, task.phase, "Завершённую задачу нельзя поставить на паузу.", false);
        return { ok: false, reason: "Задача уже завершена.", ...this.getState(scopeId) };
      }
      updatePaused.run(paused ? 1 : 0, scopeId);
      log(scopeId, paused ? "pause" : "resume", task.phase, task.phase, paused ? "Задача поставлена на паузу." : "Работа продолжена.", true);
      return { ok: true, ...this.getState(scopeId) };
    },

    reset(scopeId, task) {
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteEvents.run(scopeId);
        database.prepare(`DELETE FROM agent_tasks WHERE scope_id = ?`).run(scopeId);
        insertTask.run(scopeId, task.title, task.phase, task.currentStep, task.expectedAction, task.paused ? 1 : 0);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return this.getState(scopeId);
    },

    close() {
      database.close();
    },
  };
}
