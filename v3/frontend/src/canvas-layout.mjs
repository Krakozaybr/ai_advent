export function getCanvasExtent(lanes) {
  return {
    minWidth: Math.max(1_100, ...lanes.map((lane) => lane.x + lane.width + 100)),
    minHeight: Math.max(830, ...lanes.map((lane) => lane.y + 780)),
    newLaneY: Math.max(700, ...lanes.map((lane) => lane.y + 650)),
  };
}

export function getCenteredScrollTarget(lane, viewport) {
  return {
    left: Math.max(0, lane.x + lane.width / 2 - viewport.width / 2),
    top: Math.max(0, lane.y + 310 - viewport.height / 2),
  };
}
