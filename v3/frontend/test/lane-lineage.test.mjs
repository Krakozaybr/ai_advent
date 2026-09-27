import test from "node:test";
import assert from "node:assert/strict";
import { describeLaneOrigin } from "../src/lane-lineage.mjs";

test("branch lineage shows a compact excerpt from its exact source message", () => {
  assert.deepEqual(describeLaneOrigin("branch", "  Уточни план\nдля релиза  "), {
    label: "Ветка после сообщения",
    excerpt: "Уточни план для релиза",
  });
});

test("clone lineage identifies a copy of the full conversation", () => {
  assert.deepEqual(describeLaneOrigin("clone"), {
    label: "Клон всей истории",
    excerpt: "",
  });
});
