import { DEFAULT_DAY7_SYSTEM_PROMPT } from "./day7.js";

export const DAY11_SCOPE_ID = "day11-default";

export const DEFAULT_DAY11_SYSTEM_PROMPT = `${DEFAULT_DAY7_SYSTEM_PROMPT}
Используй только те сведения о пользователе и задаче, которые явно переданы в слоях памяти.`;

export const DAY11_MEMORY_LAYERS = {
  shortTerm: {
    title: "Краткосрочная",
    description: "Текущий диалог и временные записи этой сессии.",
  },
  working: {
    title: "Рабочая",
    description: "Цель, ограничения и решения текущей задачи.",
  },
  longTerm: {
    title: "Долговременная",
    description: "Устойчивые предпочтения и знания о пользователе.",
  },
};

export const DAY11_DEFAULT_MEMORY = {
  shortTerm: {
    key: "current_request",
    value: "Нужно подготовить план небольшого учебного проекта.",
  },
  working: {
    key: "deadline",
    value: "Прототип должен быть готов к пятнице.",
  },
  longTerm: {
    key: "preferred_stack",
    value: "Пользователь предпочитает JavaScript и короткие ответы на русском языке.",
  },
};

export const DAY11_DEFAULT_PROMPT =
  "Составь короткий план проекта с учётом известных тебе условий и предпочтений.";
