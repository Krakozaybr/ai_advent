export type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export type RunState = {
  sequence: number;
  status: RunStatus;
  answer: string;
  error: string | null;
};

export type RunEvent = {
  sequence: number;
  type: "run.started" | "text.delta" | "run.completed" | "run.failed" | "run.cancelled" | "tool.started" | "tool.completed";
  data: { text?: string; error?: string; toolName?: string; serverId?: string; arguments?: unknown; result?: unknown; ok?: boolean };
};

export function applyRunEvent(current: RunState, event: RunEvent): RunState;
export function emptyRunState(sequence?: number): RunState;
export function applyToolRunEvent(current: Array<Record<string, unknown>>, event: RunEvent): Array<Record<string, unknown>>;
