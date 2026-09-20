import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DAY15_GUARDS, DAY15_TRANSITIONS } from "../shared/day15.js";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");

export function createLifecycleStore(filePath = DEFAULT_DATABASE_PATH) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  database.exec(`
    CREATE TABLE IF NOT EXISTS controlled_lifecycles (
      scope_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('planning', 'execution', 'validation', 'done')),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      plan_approved INTEGER NOT NULL DEFAULT 0 CHECK (plan_approved IN (0, 1)),
      implementation_complete INTEGER NOT NULL DEFAULT 0 CHECK (implementation_complete IN (0, 1)),
      validation_passed INTEGER NOT NULL DEFAULT 0 CHECK (validation_passed IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS controlled_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      details TEXT NOT NULL,
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS controlled_lifecycle_events_scope_id_id
      ON controlled_lifecycle_events (scope_id, id);
  `);

  const insertLifecycle = database.prepare(`
    INSERT OR IGNORE INTO controlled_lifecycles (
      scope_id, title, state, paused, plan_approved,
      implementation_complete, validation_passed
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getLifecycle = database.prepare(`
    SELECT scope_id AS scopeId, title, state, paused,
      plan_approved AS planApproved,
      implementation_complete AS implementationComplete,
      validation_passed AS validationPassed,
      updated_at AS updatedAt
    FROM controlled_lifecycles WHERE scope_id = ?
  `);
  const updateState = database.prepare(`
    UPDATE controlled_lifecycles SET state = ?, paused = 0,
      updated_at = CURRENT_TIMESTAMP WHERE scope_id = ?
  `);
  const updatePaused = database.prepare(`
    UPDATE controlled_lifecycles SET paused = ?, updated_at = CURRENT_TIMESTAMP
    WHERE scope_id = ?
  `);
  const updatePlanApproved = database.prepare(`
    UPDATE controlled_lifecycles SET plan_approved = ?, updated_at = CURRENT_TIMESTAMP
    WHERE scope_id = ?
  `);
  const updateImplementationComplete = database.prepare(`
    UPDATE controlled_lifecycles SET implementation_complete = ?, updated_at = CURRENT_TIMESTAMP
    WHERE scope_id = ?
  `);
  const updateValidationPassed = database.prepare(`
    UPDATE controlled_lifecycles SET validation_passed = ?, updated_at = CURRENT_TIMESTAMP
    WHERE scope_id = ?
  `);
  const guardStatements = {
    planApproved: updatePlanApproved,
    implementationComplete: updateImplementationComplete,
    validationPassed: updateValidationPassed,
  };
  const insertEvent = database.prepare(`
    INSERT INTO controlled_lifecycle_events (
      scope_id, event_type, from_state, to_state, details, accepted
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listEvents = database.prepare(`
    SELECT id, event_type AS eventType, from_state AS fromState,
      to_state AS toState, details, accepted, created_at AS createdAt
    FROM controlled_lifecycle_events WHERE scope_id = ? ORDER BY id DESC LIMIT 50
  `);
  const deleteLifecycle = database.prepare(`DELETE FROM controlled_lifecycles WHERE scope_id = ?`);
  const deleteEvents = database.prepare(`DELETE FROM controlled_lifecycle_events WHERE scope_id = ?`);

  function normalizeLifecycle(row) {
    if (!row) return null;
    const { planApproved, implementationComplete, validationPassed, ...rest } = row;
    return {
      ...rest,
      paused: Boolean(row.paused),
      guards: {
        planApproved: Boolean(planApproved),
        implementationComplete: Boolean(implementationComplete),
        validationPassed: Boolean(validationPassed),
      },
    };
  }

  function log(scopeId, eventType, fromState, toState, details, accepted) {
    insertEvent.run(scopeId, eventType, fromState, toState, details, accepted ? 1 : 0);
  }

  function state(scopeId) {
    return {
      lifecycle: normalizeLifecycle(getLifecycle.get(scopeId)),
      events: listEvents.all(scopeId).map((event) => ({
        ...event,
        accepted: Boolean(event.accepted),
      })),
    };
  }

  return {
    ensure(scopeId, lifecycle) {
      insertLifecycle.run(
        scopeId,
        lifecycle.title,
        lifecycle.state,
        lifecycle.paused ? 1 : 0,
        lifecycle.guards.planApproved ? 1 : 0,
        lifecycle.guards.implementationComplete ? 1 : 0,
        lifecycle.guards.validationPassed ? 1 : 0,
      );
      return state(scopeId);
    },

    getState(scopeId) {
      return state(scopeId);
    },

    setGuard(scopeId, guard, value) {
      if (!Object.hasOwn(guardStatements, guard)) {
        return { ok: false, reason: "Неизвестное условие перехода.", ...state(scopeId) };
      }
      guardStatements[guard].run(value ? 1 : 0, scopeId);
      const current = normalizeLifecycle(getLifecycle.get(scopeId));
      log(scopeId, "guard_updated", current.state, current.state, `${DAY15_GUARDS[guard].label}: ${value ? "да" : "нет"}.`, true);
      return { ok: true, ...state(scopeId) };
    },

    transition(scopeId, target) {
      const current = normalizeLifecycle(getLifecycle.get(scopeId));
      const transition = DAY15_TRANSITIONS[current.state];
      if (current.paused) {
        const reason = "Задача на паузе. Сначала продолжите работу.";
        log(scopeId, "transition", current.state, target, reason, false);
        return { ok: false, reason, ...state(scopeId) };
      }
      if (!transition || transition.target !== target) {
        const reason = transition
          ? `Переход ${current.state} → ${target} запрещён. Следующее допустимое состояние: ${transition.target}.`
          : "Задача уже завершена: переходы из done запрещены.";
        log(scopeId, "transition", current.state, target, reason, false);
        return { ok: false, reason, ...state(scopeId) };
      }
      if (!current.guards[transition.guard]) {
        const reason = `Переход заблокирован: условие «${DAY15_GUARDS[transition.guard].label}» не выполнено.`;
        log(scopeId, "transition", current.state, target, reason, false);
        return { ok: false, reason, ...state(scopeId) };
      }
      updateState.run(target, scopeId);
      const reason = `Переход ${current.state} → ${target} выполнен.`;
      log(scopeId, "transition", current.state, target, reason, true);
      return { ok: true, reason, ...state(scopeId) };
    },

    setPaused(scopeId, paused) {
      const current = normalizeLifecycle(getLifecycle.get(scopeId));
      if (current.state === "done") {
        const reason = "Завершённую задачу нельзя поставить на паузу.";
        log(scopeId, paused ? "pause" : "resume", current.state, current.state, reason, false);
        return { ok: false, reason, ...state(scopeId) };
      }
      updatePaused.run(paused ? 1 : 0, scopeId);
      const reason = paused ? "Задача поставлена на паузу." : "Работа продолжена с сохранённого состояния.";
      log(scopeId, paused ? "pause" : "resume", current.state, current.state, reason, true);
      return { ok: true, reason, ...state(scopeId) };
    },

    reset(scopeId, lifecycle) {
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteEvents.run(scopeId);
        deleteLifecycle.run(scopeId);
        insertLifecycle.run(
          scopeId,
          lifecycle.title,
          lifecycle.state,
          lifecycle.paused ? 1 : 0,
          lifecycle.guards.planApproved ? 1 : 0,
          lifecycle.guards.implementationComplete ? 1 : 0,
          lifecycle.guards.validationPassed ? 1 : 0,
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { ok: true, reason: "Жизненный цикл сброшен.", ...state(scopeId) };
    },

    close() {
      database.close();
    },
  };
}
