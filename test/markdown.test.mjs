import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMathDelimiters } from "../src/markdown.js";

test("normalizes OpenRouter LaTeX delimiters for the Markdown renderer", () => {
  const answer = String.raw`Inline: \(x = 3\)

\[
3x + 3 = 12
\Rightarrow x = 3
\]`;

  assert.equal(
    normalizeMathDelimiters(answer),
    `Inline: $x = 3$

$$
3x + 3 = 12
\\Rightarrow x = 3
$$`,
  );
});
