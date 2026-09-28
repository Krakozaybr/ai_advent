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
  } else if (event.type === "run.cancelled") {
    next.status = "cancelled";
  }
  return next;
}

export function emptyRunState(sequence = 0) {
  return { sequence, status: "idle", answer: "", error: null };
}

export function applyToolRunEvent(current, event) {
  if (event.type === "tool.started") {
    if (current.some((item) => item.startSequence === event.sequence)) return current;
    return [...current, { ...event.data, startSequence: event.sequence, status: "Выполняется" }];
  }
  if (event.type !== "tool.completed") return current;
  const index = current.findIndex((item) => item.toolName === event.data.toolName && item.status === "Выполняется");
  if (index < 0) return current;
  const next = [...current];
  next[index] = { ...event.data, startSequence: next[index].startSequence,
    status: event.data.result?.status === "pending" ? "Ожидает подтверждения" : event.data.ok ? "Готово" : "Ошибка" };
  return next;
}
