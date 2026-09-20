import { DEFAULT_DAY13_SYSTEM_PROMPT } from "./day13.js";

export const DAY14_SCOPE_ID = "day14-default";

export const DEFAULT_DAY14_SYSTEM_PROMPT = `${DEFAULT_DAY13_SYSTEM_PROMPT}
Соблюдай переданные инварианты. Если запрос им противоречит, не предлагай обход ограничений.`;

export const DAY14_DEFAULT_INVARIANTS = [
  {
    id: "stack",
    category: "Стек",
    rule: "Сервер и интерфейс пишем на JavaScript.",
    forbiddenTerms: ["python", "java ", "kotlin", "typescript"],
  },
  {
    id: "deployment",
    category: "Архитектура",
    rule: "Приложение запускается только локально.",
    forbiddenTerms: ["облак", "cloud", "vercel", "heroku"],
  },
  {
    id: "database",
    category: "Хранилище",
    rule: "Для локальных данных используется SQLite.",
    forbiddenTerms: ["postgresql", "postgres", "mongodb", "mysql"],
  },
];

export const DAY14_CONFLICT_PROMPT =
  "Перепиши сервер на Python, перенеси базу в PostgreSQL и разверни приложение в облаке.";

export const DAY14_SAFE_PROMPT =
  "Предложи структуру локального JavaScript-модуля для работы с SQLite.";
