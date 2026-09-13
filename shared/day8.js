export const DEFAULT_DAY8_PROMPT =
  "Составь резюме того, что ты знаешь о моём учебном проекте. Не более 70 слов.";

export const DAY8_SCENARIOS = {
  short: {
    title: "Короткий диалог",
    description: "Одна короткая пара сообщений в истории.",
  },
  long: {
    title: "Длинный диалог",
    description: "Восемь пар сообщений с требованиями проекта.",
  },
  overflow: {
    title: "Переполнение",
    description: "Большая история превышает учебный лимит до вызова API.",
  },
};

const LONG_FACTS = [
  "Проект называется AI Advent и запускается локально.",
  "Интерфейс сделан как веб-приложение с десятью вкладками.",
  "Все запросы к моделям выполняются через OpenRouter.",
  "Основная модель проекта относится к семейству Qwen.",
  "Ответы модели отображаются как Markdown.",
  "История диалога хранится в локальной базе SQLite.",
  "API-ключ хранится только локально и не возвращается браузеру.",
  "Каждый учебный день должен быть удобен для записи короткого видео.",
];

function factExchange(fact, index) {
  return [
    { role: "user", content: `Требование ${index + 1}: ${fact}` },
    { role: "assistant", content: `Принято. Учитываю требование: ${fact}` },
  ];
}

export function buildDay8History(scenario) {
  if (scenario === "short") {
    return factExchange(LONG_FACTS[0], 0);
  }

  const longHistory = LONG_FACTS.flatMap(factExchange);
  if (scenario === "long") {
    return longHistory;
  }

  if (scenario === "overflow") {
    return Array.from({ length: 4 }, () => longHistory).flat();
  }

  throw new Error("Неизвестный сценарий Дня 8.");
}
