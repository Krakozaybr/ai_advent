import test from "node:test";
import assert from "node:assert/strict";
import { createOverviewPanelState, setOverviewPanelOpen } from "../src/overview-panels.mjs";

test("board task and schedule panels start collapsed", () => {
  assert.deepEqual(createOverviewPanelState(), { tasks: false, schedules: false });
});

test("panel state updates independently and can be retained across board switches", () => {
  const opened = setOverviewPanelOpen(createOverviewPanelState(), "tasks", true);
  const switchedBoard = { ...opened };

  assert.deepEqual(switchedBoard, { tasks: true, schedules: false });
  assert.deepEqual(setOverviewPanelOpen(switchedBoard, "schedules", true), { tasks: true, schedules: true });
});
