import assert from "node:assert/strict";
import test from "node:test";
import { applyRunEvent, emptyRunState } from "../src/run-state.mjs";

test("public text deltas build the answer once and completion seals the run", () => {
  let state = emptyRunState();
  state = applyRunEvent(state, { sequence: 1, type: "run.started", data: {} });
  state = applyRunEvent(state, {
    sequence: 2,
    type: "text.delta",
    data: { text: "Привет" },
  });
  state = applyRunEvent(state, {
    sequence: 3,
    type: "run.completed",
    data: {},
  });

  assert.equal(state.answer, "Привет");
  assert.equal(state.status, "completed");
});

test("replayed SSE events do not duplicate already restored text", () => {
  const current = { sequence: 4, status: "running", answer: "Сохранено", error: null };
  const next = applyRunEvent(current, {
    sequence: 4,
    type: "text.delta",
    data: { text: "Сохранено" },
  });

  assert.equal(next, current);
  assert.equal(next.answer, "Сохранено");
});

test("failed runs expose an error without becoming a completed answer", () => {
  const state = applyRunEvent(emptyRunState(), {
    sequence: 1,
    type: "run.failed",
    data: { error: "Отключено" },
  });

  assert.equal(state.status, "failed");
  assert.equal(state.error, "Отключено");
  assert.equal(state.answer, "");
});

test("cancelled runs reach a terminal state", () => {
  const state = applyRunEvent(emptyRunState(), {
    sequence: 1,
    type: "run.cancelled",
    data: {},
  });

  assert.equal(state.status, "cancelled");
});
