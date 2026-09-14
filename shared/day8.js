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

const OVERFLOW_RECORDS_PER_MESSAGE = 220;
const PROJECT_AREAS = [
  "интерфейс чата",
  "HTTP API",
  "хранилище SQLite",
  "подсчёт токенов",
  "Markdown-ответ",
  "настройки модели",
  "сценарий для видео",
  "обработка ошибок",
];
const EXTRA_CONDITIONS = [
  "сохранить локальный запуск",
  "не раскрывать API-ключ браузеру",
  "показать параметры запроса",
  "оставить значения редактируемыми",
  "вывести измеренную стоимость",
  "объяснить результат простыми словами",
];
const NEXT_STEPS = [
  "добавить проверяемый пример",
  "сравнить результат с предыдущим запуском",
  "показать метрики рядом с ответом",
  "сохранить результат в JSON",
  "проверить поведение после перезапуска",
  "описать ограничение в интерфейсе",
];
const DECISION_REASONS = [
  "так различие будет видно на видео",
  "это сохраняет учебный код минимальным",
  "так пользователь видит реальный запрос",
  "это позволяет воспроизвести эксперимент",
  "так измерение остаётся прозрачным",
  "это не требует дополнительной настройки",
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

function buildOverflowRecord(message, messageIndex, recordIndex) {
  const recordNumber = messageIndex * OVERFLOW_RECORDS_PER_MESSAGE + recordIndex + 1;
  const day = (recordNumber % 10) + 1;
  const area = PROJECT_AREAS[recordNumber % PROJECT_AREAS.length];

  if (message.role === "user") {
    const condition = EXTRA_CONDITIONS[recordNumber % EXTRA_CONDITIONS.length];
    return `Запись ${recordNumber}. Пользователь уточняет требования Дня ${day} для блока «${area}»: ${message.content} Дополнительное условие — ${condition}.`;
  }

  const nextStep = NEXT_STEPS[recordNumber % NEXT_STEPS.length];
  const reason = DECISION_REASONS[recordNumber % DECISION_REASONS.length];
  return `Запись ${recordNumber}. Ассистент фиксирует решение Дня ${day} для блока «${area}»: ${message.content} Следующий шаг — ${nextStep}, потому что ${reason}.`;
}

function buildOverflowContent(message, messageIndex) {
  return Array.from({ length: OVERFLOW_RECORDS_PER_MESSAGE }, (_, recordIndex) =>
    buildOverflowRecord(message, messageIndex, recordIndex),
  ).join("\n");
}

function getOverflowContentLength(message, messageIndex) {
  let length = OVERFLOW_RECORDS_PER_MESSAGE - 1;
  for (let recordIndex = 0; recordIndex < OVERFLOW_RECORDS_PER_MESSAGE; recordIndex += 1) {
    length += buildOverflowRecord(message, messageIndex, recordIndex).length;
  }
  return length;
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
    return longHistory.map((message, messageIndex) => ({
      ...message,
      content: buildOverflowContent(message, messageIndex),
    }));
  }

  throw new Error("Неизвестный сценарий Дня 8.");
}

export function buildDay8HistoryPreview(scenario) {
  const history = scenario === "short" ? factExchange(LONG_FACTS[0], 0) : buildLongHistory();

  if (scenario !== "short" && scenario !== "long" && scenario !== "overflow") {
    throw new Error("Неизвестный сценарий Дня 8.");
  }

  return history.map((message, messageIndex) => {
    if (scenario !== "overflow") {
      return {
        ...message,
        sourceContent: message.content,
        fullLength: message.content.length,
        records: 1,
      };
    }

    return {
      ...message,
      content: `${buildOverflowRecord(message, messageIndex, 0)}\n${buildOverflowRecord(message, messageIndex, 1)}\n…`,
      messageIndex,
      sourceContent: message.content,
      fullLength: getOverflowContentLength(message, messageIndex),
      records: OVERFLOW_RECORDS_PER_MESSAGE,
    };
  });
}

export function expandDay8PreviewMessage(message) {
  if (message.records === 1) {
    return message.sourceContent;
  }
  return buildOverflowContent(
    { role: message.role, content: message.sourceContent },
    message.messageIndex,
  );
}
