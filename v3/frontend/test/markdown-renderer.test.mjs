import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMarkdownNode } from "../src/markdown-renderer.mjs";

function render(markdown) {
  return renderToStaticMarkup(createElement("div", null, createMarkdownNode(markdown)));
}

test("renders GFM tables, math, and highlighted code", () => {
  const html = render([
    "| x | y |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "Formula: $x^2$",
    "",
    "```js",
    "const answer = 42;",
    "```",
  ].join("\n"));

  assert.match(html, /<table>/);
  assert.match(html, /katex/);
  assert.match(html, /hljs/);
  assert.match(html, /hljs-keyword/);
});

test("keeps raw HTML inert and rejects unsafe link protocols", () => {
  const html = render('<script>alert("x")</script>\n\n[x](javascript:alert(1))');

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /&lt;script&gt;/);
});
