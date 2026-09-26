export function applyRunEvent(current, event) {
  if (event.sequence <= current.sequence) return current;

  const next = { ...current, sequence: event.sequence };
  if (event.type === "run.started") {
    next.status = "running";
  } else if (event.type === "text.delta") {
    next.answer += event.data.text;
  } else if (event.type === "run.completed") {
    next.status = "completed";
  } else if (event.type === "run.failed") {
    next.status = "failed";
    next.error = event.data.error;
  }
  return next;
}

export function emptyRunState(sequence = 0) {
  return { sequence, status: "idle", answer: "", error: null };
}
