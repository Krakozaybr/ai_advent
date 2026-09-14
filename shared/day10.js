import { DEFAULT_DAY7_SYSTEM_PROMPT } from "./day7.js";

export const DEFAULT_DAY10_SYSTEM_PROMPT = `${DEFAULT_DAY7_SYSTEM_PROMPT}
Кратко подтверждай новые требования. Если пользователь просит итог, перечисляй известные ограничения и решения.`;

export const DEFAULT_DAY10_KEEP_LAST = 4;
export const DEFAULT_DAY10_FACTS_MAX_TOKENS = 260;

export const DAY10_STRATEGIES = {
  sliding: {
    title: "Sliding Window",
    description: "В запрос попадают только последние N сообщений, старые отбрасываются.",
  },
  facts: {
    title: "Sticky Facts",
    description: "Модель обновляет JSON фактов; в запрос идут facts и последние N сообщений.",
  },
  branching: {
    title: "Branching",
    description: "Каждая ветка получает независимую копию истории от общего checkpoint.",
  },
};

const COMMON_SCRIPT = [
  "Запомни: мы составляем ТЗ для локального приложения AI Advent.",
  "Запомни: целевая аудитория — начинающие разработчики.",
  "Запомни: бюджет на API не должен превышать 50 долларов.",
  "Запомни: дедлайн — пятница.",
  "Запомни: приложение использует OpenRouter и модели Qwen.",
  "Запомни: интерфейс содержит 10 учебных вкладок.",
  "Запомни: история сохраняется в SQLite, язык интерфейса — русский.",
  "Составь итоговое ТЗ и перечисли все ограничения, которые я сообщил.",
];

export function getDay10ScriptPrompt(strategy, completedUserMessages = 0, branchId = "main") {
  if (strategy !== "branching" || branchId === "main") {
    return COMMON_SCRIPT[completedUserMessages] ?? "";
  }

  if (completedUserMessages === 3) {
    return branchId === "branch-a"
      ? "В этой ветке увеличь бюджет до 80 долларов и добавь экспорт результатов в PDF."
      : "В этой ветке сократи бюджет до 30 долларов и исключи экспорт в PDF.";
  }
  if (completedUserMessages === 4) {
    return "Назови актуальный бюджет этой ветки и скажи, нужен ли экспорт в PDF.";
  }
  return "";
}

export function getDay10BranchPrompt(branchId, completedBranchMessages = 0) {
  if (branchId !== "branch-a" && branchId !== "branch-b") {
    return "";
  }
  if (completedBranchMessages === 0) {
    return branchId === "branch-a"
      ? "В этой ветке увеличь бюджет до 80 долларов и добавь экспорт результатов в PDF."
      : "В этой ветке сократи бюджет до 30 долларов и исключи экспорт в PDF.";
  }
  if (completedBranchMessages === 1) {
    return "Назови актуальный бюджет этой ветки и скажи, нужен ли экспорт в PDF.";
  }
  return "";
}
