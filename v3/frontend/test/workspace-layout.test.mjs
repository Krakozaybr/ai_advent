import assert from "node:assert/strict";
import test from "node:test";
import { arrangeLanes } from "../src/workspace-layout.mjs";

test("branches stay beside their parent and push later roots right", () => {
  const lanes = [
    { id: "root", x: 24, y: 20, width: 440 },
    { id: "other", x: 484, y: 20, width: 440 },
    { id: "branch", originKind: "branch", originLaneId: "root", x: 944, y: 80, width: 320 },
  ];
  const arranged = arrangeLanes(lanes);
  assert.deepEqual(arranged.map((lane) => lane.id), ["root", "branch", "other"]);
  assert.deepEqual(arranged.map((lane) => lane.x), [160, 786, 1412]);
});

test("clones retain lineage but start their own visual group", () => {
  const arranged = arrangeLanes([
    { id: "root", x: 24, y: 0, width: 440 },
    { id: "other", x: 484, y: 0, width: 440 },
    { id: "clone", originKind: "clone", originLaneId: "root", x: 944, y: 0, width: 440 },
  ]);
  assert.deepEqual(arranged.map((lane) => lane.id), ["root", "other", "clone"]);
});

test("archived lanes do not occupy board columns", () => {
  const arranged = arrangeLanes([
    { id: "first", x: 24, y: 0, width: 440 },
    { id: "archived", x: 484, y: 0, width: 440, archived: true },
    { id: "last", x: 944, y: 0, width: 440 },
  ]);
  assert.deepEqual(arranged.map((lane) => lane.id), ["first", "last"]);
  assert.equal(arranged[1].x, 786);
});

test("subagents follow their launch order and occupy compact columns after the parent", () => {
  const arranged = arrangeLanes([
    { id: "lead", x: 24, y: 0, width: 560 },
    { id: "old", originKind: "subagent", originLaneId: "lead", launchOrder: 1, width: 560 },
    { id: "new", originKind: "subagent", originLaneId: "lead", launchOrder: 2, width: 560 },
    { id: "next", x: 1200, y: 0, width: 560 },
  ]);
  assert.deepEqual(arranged.map((lane) => lane.id), ["lead", "new", "old", "next"]);
  assert.deepEqual(arranged.map((lane) => lane.x), [160, 720, 1280, 1906]);
});
