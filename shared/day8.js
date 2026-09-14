export const DEFAULT_DAY8_PROMPT =
  "Составь резюме того, что ты знаешь о моём учебном проекте. Не более 70 слов.";

export const DEFAULT_DAY8_CONTEXT_LIMIT = 262_144;

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
    description: "История больше контекстного окна и всё равно отправляется в OpenRouter.",
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

function buildLongHistory() {
  return LONG_FACTS.flatMap(factExchange);
}

export function buildDay8History(scenario) {
  if (scenario === "short") {
    return factExchange(LONG_FACTS[0], 0);
  }

  const longHistory = buildLongHistory();
  if (scenario === "long") {
    return longHistory;
  }

  if (scenario === "overflow") {
    return longHistory.map((message) => ({
      ...message,
      content: Array.from({ length: 700 }, () => message.content).join(" "),
    }));
  }

  throw new Error("Неизвестный сценарий Дня 8.");
}

export function buildDay8HistoryPreview(scenario) {
  const history = scenario === "short" ? factExchange(LONG_FACTS[0], 0) : buildLongHistory();

  if (scenario !== "short" && scenario !== "long" && scenario !== "overflow") {
    throw new Error("Неизвестный сценарий Дня 8.");
  }

  return history.map((message) => {
    if (scenario !== "overflow") {
      return {
        ...message,
        sourceContent: message.content,
        fullLength: message.content.length,
        repetitions: 1,
      };
    }

    return {
      ...message,
      content: `${message.content} …`,
      sourceContent: message.content,
      fullLength: message.content.length * 700 + 699,
      repetitions: 700,
    };
  });
}

export function expandDay8PreviewMessage(message) {
  return Array.from({ length: message.repetitions }, () => message.sourceContent).join(" ");
}
