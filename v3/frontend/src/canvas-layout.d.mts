export type CanvasLane = { x: number; y: number; width: number };
export type CanvasExtent = { minWidth: number; minHeight: number; newLaneY: number };
export function getCanvasExtent(lanes: CanvasLane[]): CanvasExtent;
export function getCenteredScrollTarget(lane: CanvasLane, viewport: { width: number; height: number }): { left: number; top: number };
