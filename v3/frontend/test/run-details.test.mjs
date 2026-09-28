import assert from "node:assert/strict";
import test from "node:test";
import { tokenizeJson, wasConfigurationChanged } from "../src/run-details.mjs";

test("JSON tokenizer distinguishes keys, strings, and literals without interpreting text", () => {
  const tokens = tokenizeJson('{"model":"gpt-6-sol","stream":true}');
  assert.deepEqual(tokens.filter((token) => token.kind === "key").map((token) => token.text), ['"model"', '"stream"']);
  assert.deepEqual(tokens.filter((token) => token.kind === "string").map((token) => token.text), ['"gpt-6-sol"']);
  assert.deepEqual(tokens.filter((token) => token.kind === "literal").map((token) => token.text), ["true"]);
});

test("only changed configuration is flagged on the next sent message", () => {
  const previous = { model: "a", contextPlan: { messages: [1] } };
  assert.equal(wasConfigurationChanged(previous, { model: "a", contextPlan: { messages: [1, 2] } }), false);
  assert.equal(wasConfigurationChanged(previous, { model: "b" }), true);
  assert.equal(wasConfigurationChanged(null, previous), false);
});
