export function describeLaneOrigin(kind, content = "") {
  if (kind === "subagent") {
    return { label: "Сабагент от сообщения", excerpt: content.trim().replace(/\s+/g, " ").slice(0, 120) };
  }
  if (kind === "branch") {
    return {
      label: "Ветка после сообщения",
      excerpt: content.trim().replace(/\s+/g, " ").slice(0, 120),
    };
  }
  return { label: "Клон всей истории", excerpt: "" };
}
