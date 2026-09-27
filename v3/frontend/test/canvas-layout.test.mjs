import assert from "node:assert/strict";
import test from "node:test";
import { getCanvasExtent, getCenteredScrollTarget } from "../src/canvas-layout.mjs";

test("canvas extent follows saved lane positions and leaves room for a new lane", () => {
  assert.deepEqual(getCanvasExtent([{ x: 24, y: 24, width: 440 }, { x: 1_200, y: 900, width: 600 }]), {
    minWidth: 1_900,
    minHeight: 1_680,
    newLaneY: 1_550,
  });
});

test("focus mode centers the selected lane in the visible canvas", () => {
  assert.deepEqual(getCenteredScrollTarget({ x: 1_000, y: 700, width: 500 }, { width: 800, height: 600 }), {
    left: 850,
    top: 710,
  });
});
