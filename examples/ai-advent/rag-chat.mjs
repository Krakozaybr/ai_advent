import { readFile } from "node:fs/promises";
import { ask, writeJsonAtomic } from "./rag.mjs";

export const emptyChat = () => ({ version: 1, state: { goal: "", constraints: [], clarifications: [], terms: {} }, history: [] });

export async function loadChat(path) {
  try {
    const chat = JSON.parse(await readFile(path, "utf8"));
    if (chat.version !== 1 || !chat.state || !Array.isArray(chat.history)) throw new Error("Неверный файл чата.");
    return chat;
  } catch (error) {
    if (error.code === "ENOENT") return emptyChat();
    throw error;
  }
}

export function updateTaskState(chat, command) {
  const match = command.match(/^\/(goal|constraint|clarify|term)\s+(.+)$/u);
  if (!match) return false;
  const [, kind, value] = match;
  if (kind === "goal") chat.state.goal = value.trim();
  if (kind === "constraint") chat.state.constraints.push(value.trim());
  if (kind === "clarify") chat.state.clarifications.push(value.trim());
  if (kind === "term") {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error("Термин задаётся как /term название=значение.");
    chat.state.terms[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
  }
  return true;
}

export async function chatTurn({ client, index, chat, input, path, threshold = 0.25 }) {
  if (updateTaskState(chat, input)) {
    await writeJsonAtomic(path, chat);
    return { stateUpdated: true, state: chat.state };
  }
  const result = await ask({ client, index, question: input, threshold, state: chat.state, history: chat.history });
  chat.history.push({ role: "user", content: input });
  chat.history.push({ role: "assistant", content: result.answer, citations: result.citations });
  await writeJsonAtomic(path, chat);
  return result;
}
