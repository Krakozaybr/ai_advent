import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./day6.js";

export const DAY7_CONVERSATION_ID = "day7-default";
export const DEFAULT_DAY7_AGENT_NAME = "Агент с памятью";
export const DEFAULT_DAY7_SYSTEM_PROMPT = `${DEFAULT_AGENT_SYSTEM_PROMPT}
Учитывай факты из предыдущих сообщений диалога.`;

export const DAY7_REMEMBER_MESSAGE =
  "Запомни: мой любимый язык программирования — JavaScript. Ответь, что запомнил.";

export const DAY7_RECALL_MESSAGE = "Какой мой любимый язык программирования?";
