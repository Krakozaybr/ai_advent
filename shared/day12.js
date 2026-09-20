import { DEFAULT_DAY11_SYSTEM_PROMPT } from "./day11.js";

export const DAY12_SCOPE_ID = "day12-default";

export const DEFAULT_DAY12_SYSTEM_PROMPT = `${DEFAULT_DAY11_SYSTEM_PROMPT}
Адаптируй объяснение под профиль пользователя, переданный отдельным системным сообщением.`;

export const DAY12_DEFAULT_PROMPT =
  "Объясни, как работает REST API, и предложи небольшой практический пример.";

export const DAY12_DEFAULT_PROFILES = [
  {
    id: "beginner",
    name: "Начинающий разработчик",
    expertise: "Начальный уровень. Знает основы JavaScript, но впервые работает с API.",
    style: "Объясняй спокойно, простыми словами и через аналогию.",
    format: "Короткое объяснение, затем нумерованный пример из трёх шагов.",
    constraints: "Не используй термины без пояснения. Не больше 180 слов.",
    language: "Русский",
  },
  {
    id: "expert",
    name: "Опытный backend-разработчик",
    expertise: "Уверенно работает с HTTP, JavaScript и серверной архитектурой.",
    style: "Пиши плотно и технически, без вводных объяснений.",
    format: "Тезисы и компактный пример кода.",
    constraints: "Не объясняй базовые термины. Не больше 180 слов.",
    language: "Русский",
  },
];
