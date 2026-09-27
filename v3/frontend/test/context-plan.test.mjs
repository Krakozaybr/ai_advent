import test from "node:test";
import assert from "node:assert/strict";
import { planContext } from "../src/context-plan.mjs";

const transcript = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "last" },
];

test("full keeps all transcript and adds the current message only to the estimate", () => {
  const plan = planContext(transcript, "next", { strategy: "full", windowSize: 1, summary: "", budgetTokens: 100, responseTokensEstimate: 10 });
  assert.deepEqual(plan.messages, transcript);
  assert.equal(plan.omittedMessages, 0);
  assert.equal(plan.currentMessageTokensEstimate, 1);
});

test("window strategies select last N and summary remains a separate user entry", () => {
  const plan = planContext(transcript, "next", { strategy: "summary_window", windowSize: 1, summary: "facts", summaryWatermark: "m2", budgetTokens: 100, responseTokensEstimate: 10 });
  assert.deepEqual(plan.messages.map(({ role, content }) => [role, content]), [["user", "Сводка предыдущего диалога (до watermark m2):\nfacts"], ["user", "last"]]);
  assert.equal(plan.omittedMessages, 2);
});

test("overflow is surfaced as a flag instead of deleting messages", () => {
  const plan = planContext(transcript, "next", { strategy: "full", windowSize: 1, summary: "", budgetTokens: 5, responseTokensEstimate: 10 });
  assert.equal(plan.overflow, true);
  assert.equal(plan.messages.length, transcript.length);
});
