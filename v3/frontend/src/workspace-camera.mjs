export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 1.55;

export function centerCameraOnLane(lane, viewport, zoom = 0.9, previousY = null) {
  return {
    zoom,
    x: viewport.width / 2 - (lane.x + lane.width / 2) * zoom,
    y: previousY ?? 62 - lane.y * zoom,
  };
}

export function panCamera(camera, deltaX, deltaY, fixed = false) {
  return { ...camera, x: fixed ? camera.x : camera.x - deltaX, y: camera.y - deltaY };
}

export function zoomCameraAt(camera, factor, point, focusedLane = null, viewportWidth = 0) {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  const scale = zoom / camera.zoom;
  return {
    zoom,
    x: focusedLane
      ? viewportWidth / 2 - (focusedLane.x + focusedLane.width / 2) * zoom
      : point.x - (point.x - camera.x) * scale,
    y: point.y - (point.y - camera.y) * scale,
  };
}

export function stickyHeaderOffset(cameraY, zoom, laneY, laneHeight, headerHeight = 51) {
  if (zoom <= 0 || laneHeight <= headerHeight) return 0;
  return Math.max(0, Math.min(laneHeight - headerHeight, -cameraY / zoom - laneY));
}
