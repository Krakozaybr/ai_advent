import test from 'node:test';
import assert from 'node:assert/strict';
import { centerCameraOnLane, panCamera, stickyHeaderOffset, zoomCameraAt } from '../src/workspace-camera.mjs';

test('centers the selected session without discarding vertical position', () => {
  assert.deepEqual(centerCameraOnLane({ x: 100, y: 250, width: 560 }, { width: 1200, height: 800 }, 1, -80), {
    x: 220, y: -80, zoom: 1,
  });
});

test('free camera pans in two axes while fixed camera keeps horizontal center', () => {
  const camera = { x: 200, y: 100, zoom: 1 };
  assert.deepEqual(panCamera(camera, 30, 40), { x: 170, y: 60, zoom: 1 });
  assert.deepEqual(panCamera(camera, 30, 40, true), { x: 200, y: 60, zoom: 1 });
});

test('zoom keeps the pointer anchored and respects limits', () => {
  const camera = { x: 100, y: 50, zoom: 1 };
  assert.deepEqual(zoomCameraAt(camera, 1.2, { x: 300, y: 250 }), { x: 60, y: 10, zoom: 1.2 });
  assert.equal(zoomCameraAt(camera, 99, { x: 0, y: 0 }).zoom, 1.55);
  assert.equal(zoomCameraAt(camera, 0.01, { x: 0, y: 0 }).zoom, 0.55);
});

test('header follows the camera only while its lane still intersects the viewport', () => {
  assert.equal(stickyHeaderOffset(60, 1, 100, 600), 0);
  assert.equal(stickyHeaderOffset(-150, 1, 100, 600), 50);
  assert.equal(stickyHeaderOffset(-1000, 1, 100, 600), 549);
  assert.equal(stickyHeaderOffset(-300, 0.5, 100, 600), 500);
});
