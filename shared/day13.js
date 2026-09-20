import { DEFAULT_DAY12_SYSTEM_PROMPT } from "./day12.js";

export const DAY13_SCOPE_ID = "day13-default";

export const DAY13_PHASES = ["planning", "execution", "validation", "done"];

export const DAY13_PHASE_LABELS = {
  planning: "Планирование",
  execution: "Реализация",
  validation: "Проверка",
  done: "Готово",
};

export const DAY13_DEFAULT_TASK = {
  title: "Подготовить локального AI-ассистента к демонстрации",
  phase: "planning",
  currentStep: "Согласовать состав минимальной версии",
  expectedAction: "Пользователь подтверждает план",
  paused: false,
};

export const DEFAULT_DAY13_SYSTEM_PROMPT = `${DEFAULT_DAY12_SYSTEM_PROMPT}
Перед ответом учитывай формальное состояние текущей задачи. Не утверждай, что завершён этап, который не отмечен в состоянии.`;

export const DAY13_DEFAULT_PROMPT =
  "Что уже известно о задаче и какое действие нужно выполнить следующим?";
