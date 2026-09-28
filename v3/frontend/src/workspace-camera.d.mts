export type WorkspaceCamera = { x: number; y: number; zoom: number };
export type CameraLane = { x: number; y: number; width: number };
export function centerCameraOnLane(lane: CameraLane, viewport: { width: number; height: number }, zoom?: number, previousY?: number | null): WorkspaceCamera;
export function panCamera(camera: WorkspaceCamera, deltaX: number, deltaY: number, fixed?: boolean): WorkspaceCamera;
export function zoomCameraAt(camera: WorkspaceCamera, factor: number, point: { x: number; y: number }, focusedLane?: CameraLane | null, viewportWidth?: number): WorkspaceCamera;
export function stickyHeaderOffset(cameraY: number, zoom: number, laneY: number, laneHeight: number, headerHeight?: number): number;
