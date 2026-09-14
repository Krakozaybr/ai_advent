import { DEFAULT_DAY7_SYSTEM_PROMPT } from "./day7.js";

export const DEFAULT_DAY9_SYSTEM_PROMPT = `${DEFAULT_DAY7_SYSTEM_PROMPT}
Когда пользователь просит запомнить требование, кратко подтверди его. Когда он просит итог, перечисли все сохранённые факты.`;

export const DEFAULT_DAY9_KEEP_LAST = 4;
export const DEFAULT_DAY9_SUMMARY_MAX_TOKENS = 220;

export const DAY9_VARIANTS = {
  full: {
    title: "Без сжатия",
    description: "В модель отправляется вся история диалога.",
  },
  compressed: {
    title: "Со сжатием",
    description: "В модель отправляются summary и последние N сообщений.",
  },
};

const DAY9_SCRIPT = [
  "Запомни: учебный проект называется AI Advent.",
  "Запомни: приложение запускается локально и содержит 10 вкладок.",
  "Запомни: запросы идут через OpenRouter, основное семейство моделей — Qwen.",
  "Запомни: история хранится в SQLite, а API-ключ остаётся только на локальном компьютере.",
  "Перечисли все требования к проекту, которые я просил запомнить. Ничего не пропускай.",
];

export function getDay9ScriptPrompt(completedUserMessages = 0) {
  return DAY9_SCRIPT[completedUserMessages] ?? "";
}
