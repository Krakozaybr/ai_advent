import test from "node:test";
import assert from "node:assert/strict";
import { chooseBoardId } from "../src/workspace-state.mjs";

test("restores the saved board when it still exists", () => {
  assert.equal(chooseBoardId("second", [{ id: "first" }, { id: "second" }]), "second");
});

test("falls back to the first board when the saved selection is stale", () => {
  assert.equal(chooseBoardId("removed", [{ id: "first" }]), "first");
});

test("returns no selection when there are no boards", () => {
  assert.equal(chooseBoardId(null, []), null);
});
