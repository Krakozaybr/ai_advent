export type RunStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export type RunState = {
  sequence: number;
  status: RunStatus;
  answer: string;
  error: string | null;
};

export type RunEvent = {
  sequence: number;
  type: "run.started" | "text.delta" | "run.completed" | "run.failed" | "run.cancelled";
  data: { text?: string; error?: string };
};

export function applyRunEvent(current: RunState, event: RunEvent): RunState;
export function emptyRunState(sequence?: number): RunState;
