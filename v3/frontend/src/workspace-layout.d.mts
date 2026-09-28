export type PositionedLane = { id: string; originLaneId?: string; originKind?: "branch" | "clone" | "subagent"; launchOrder?: number; archived?: boolean; x: number; y: number; width: number };
export function arrangeLanes<T extends PositionedLane>(lanes: T[], gap?: number): T[];
