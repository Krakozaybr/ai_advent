import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "boards");
const provenance = "Демонстрационный ответ из seed-пакета; это не результат вызова модели.";
const message = (externalId, role, content, source) => ({
  externalId,
  role,
  content,
  ...(role === "assistant" ? { provenance: source ?? provenance } : {}),
});
const lane = (id, title, messages, options = {}) => ({
  externalId: id,
  title,
  provider: options.provider ?? "openrouter",
  ...((options.model ?? (options.provider === "codex" ? "" : "openai/gpt-4o-mini"))
    ? { model: options.model ?? "openai/gpt-4o-mini" }
    : {}),
  ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  ...(options.stop === undefined ? {} : { stop: options.stop }),
  contextStrategy: options.contextStrategy ?? "full",
  contextWindowSize: options.contextWindowSize ?? 10,
  contextBudgetTokens: options.contextBudgetTokens ?? 32768,
  ...(options.summary ? { summary: options.summary } : {}),
  ...(options.instructions ? { instructions: options.instructions } : {}),
  ...(options.instructionMode ? { instructionMode: options.instructionMode } : {}),
  layout: { x: 24 + options.index * 460, y: 24, width: 440 },
  messages,
  ...(options.origin ? { origin: options.origin } : {}),
  ...(options.agentExternalId ? { agentExternalId: options.agentExternalId } : {}),
});
const board = (day, title, lanes, agents = []) => ({
  externalId: `ai-advent-day-${day}`,
  title,
  ...(agents.length ? { agents } : {}),
  lanes,
});
const task = "Спроектируй для библиотеки простую систему возврата книг: опиши действия читателя и библиотекаря, три правила и один крайний случай. Ответ — до 120 слов.";

const boards = [
  board(1, "День 1 · Первый запрос", [lane("baseline", "Первый запрос", [message("task", "user", "Предложи один простой способ уменьшить количество пластиковых стаканчиков в офисе. Дай конкретный шаг и ожидаемый эффект.")], { index: 0, provider: "codex" })]),
  board(2, "День 2 · Формат ответа", [
    lane("free", "Свободный формат", [message("setup", "user", "Ответь в свободном формате, без жёсткого ограничения длины."), message("setup-demo", "assistant", "Понял. Выберу структуру по смыслу.") , message("same-task", "user", task), message("answer-demo", "assistant", "Читатель находит книгу по каталогу и предъявляет её на стойке. Библиотекарь проверяет срок и оформляет выдачу. Возврат принимается в ящик или на стойке; просрочка блокирует новые выдачи до возврата.")], { index: 0 }),
    lane("constrained", "Формат, длина и stop", [message("setup", "user", "Отвечай ровно тремя строками с метками ДЕЙСТВИЕ:, ПРАВИЛО: и ИСКЛЮЧЕНИЕ:. Не более 45 слов всего. Закончи последовательностью <END> и после неё ничего не добавляй."), message("setup-demo", "assistant", "Формат принят; завершение ограничу маркером.") , message("same-task", "user", task), message("answer-demo", "assistant", "ДЕЙСТВИЕ: Читатель выбирает книгу по каталогу.\nПРАВИЛО: Библиотекарь проверяет срок и регистрирует выдачу.\nИСКЛЮЧЕНИЕ: Просрочка блокирует новые выдачи до возврата.\n<END>")], { index: 1, stop: "<END>" }),
  ]),
  board(3, "День 3 · Подходы к задаче", [
    lane("direct", "Прямой запрос", [message("task", "user", task), message("demo", "assistant", "Читатель выбирает книгу в каталоге, библиотекарь проверяет доступность и срок возврата, затем записывает выдачу. Просроченную книгу нужно вернуть до новой выдачи.")], { index: 0 }),
    lane("steps", "Краткие шаги", [message("task", "user", `${task}\nПокажи только краткие проверяемые шаги решения, без скрытых рассуждений.`), message("demo", "assistant", "1. Уточнить роли и событие выдачи.\n2. Задать проверку срока возврата.\n3. Учесть просрочку как крайний случай.")], { index: 1 }),
    lane("meta", "Улучшение запроса · два вызова", [message("rewrite-task", "user", `Вызов 1. Пока не решай задачу. Перепиши исходный запрос как точное задание исполнителю: явно задай роли, действия, три правила и крайний случай. Исходный запрос: ${task}`)], { index: 2 }),
    lane("experts", "Взгляд специалистов", [message("task", "user", `Сравни коротко взгляды библиотекаря, читателя и администратора на задачу. Затем дай единый вариант: ${task}`), message("demo", "assistant", "Библиотекарь отвечает за учёт, читатель — за ясные сроки, администратор — за исключения. Общее правило: выдача регистрируется с датой возврата; просрочка блокирует следующую выдачу.")], { index: 3, origin: { laneExternalId: "direct", messageExternalId: "task", kind: "branch" } }),
  ]),
  board(4, "День 4 · Температура", [
    lane("t0", "temperature 0", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 0, temperature: 0 }),
    lane("t07", "temperature 0.7", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 1, temperature: 0.7 }),
    lane("t12", "temperature 1.2", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 2, temperature: 1.2 }),
  ]),
  board(5, "День 5 · Три модели Qwen", [
    lane("economy", "Qwen3 8B · экономичная", [message("task", "user", "Составь план из четырёх шагов для районного обмена книгами. Используй конкретные действия и короткие формулировки.")], { index: 0, model: "qwen/qwen3-8b", temperature: 0.2, maxTokens: 256 }),
    lane("mid", "Qwen3 30B A3B Instruct 2507", [message("task", "user", "Составь план из четырёх шагов для районного обмена книгами. Используй конкретные действия и короткие формулировки.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507", temperature: 0.2, maxTokens: 256 }),
    lane("premium", "Qwen3 235B A22B Instruct 2507", [message("task", "user", "Составь план из четырёх шагов для районного обмена книгами. Используй конкретные действия и короткие формулировки.")], { index: 2, model: "qwen/qwen3-235b-a22b-2507", temperature: 0.2, maxTokens: 256 }),
  ]),
  board(6, "День 6 · Агент как сущность", [lane("agent-run", "Задача агента", [message("task", "user", "Агент: помоги подготовить встречу книжного клуба. Разбей работу на этапы и задай один уточняющий вопрос перед выбором даты.")], { index: 0, agentExternalId: "book-club-planner" })], [{ externalId: "book-club-planner", name: "Планировщик книжного клуба", description: "Отдельный объект агента, сохранённый на доске и связанный с рабочей лентой.", instructions: "Собирай цель встречи, участников, место, дату и бюджет. Сначала уточни недостающие данные, затем предложи проверяемый план. Не назначай дату без согласования." }]),
  board(7, "День 7 · Сохранение контекста", [lane("persistent-context", "Продолжение после перезапуска", [message("goal", "user", "Мы готовим районный обмен книгами. Цель — собрать 30 книг за неделю."), message("decision", "assistant", "Черновой план: точка сбора в библиотеке, учёт по жанрам, объявление в районном чате."), message("constraint", "user", "Учти, что волонтёров только двое и хранить книги можно не больше недели."), message("next", "user", "Продолжи план с учётом договорённостей и ограничений.")], { index: 0 })]),
  board(8, "День 8 · Размер контекста", [
    lane("short", "Короткая история", [message("task", "user", "Напомни цель: собрать 30 книг за неделю. Предложи следующий шаг.")], { index: 0 }),
    lane("long", "Длинная история", Array.from({ length: 12 }, (_, i) => message(`m${i}`, i % 2 ? "assistant" : "user", i % 2 ? `Заметка ${i}: согласован промежуточный пункт подготовки; ответственный подтвердит выполнение до конца дня.` : `Заметка ${i}: для книжного обмена проверяем сбор, сортировку, помещение и расписание; условие ${i} нужно сверить с волонтёрами.`)).concat(message("task", "user", "Суммируй подтверждённые договорённости и предложи один следующий шаг.")), { index: 1 }),
    lane("overflow", "Переполнение · force-send", Array.from({ length: 12 }, (_, i) => message(`m${i}`, i % 2 ? "assistant" : "user", `${`Подробная заметка ${i}: `.repeat(24)}срок, ответственный, состояние и способ проверки должны оставаться видимыми для координатора.`)).concat(message("task", "user", "Суммируй все ограничения и предложи ближайший шаг.")), { index: 2, contextBudgetTokens: 256, maxTokens: 2048 }),
  ]),
  board(9, "День 9 · Стратегии контекста", [
    lane("full", "Полная история", [message("history-1", "user", "Цель: устроить обмен книгами для 20 семей."), message("history-2", "assistant", "Нужны место, учёт и правило безопасности."), message("history-3", "user", "Место — библиотека; учёт по жанрам; повреждённые книги откладываем."), message("history-4", "assistant", "Добавить подписанные коробки, ответственного за приём и отдельную полку для проверки."), message("question", "user", "Составь план и не забудь условие про повреждённые книги.")], { index: 0, contextStrategy: "full" }),
    lane("sliding", "Последние сообщения", [message("history-1", "user", "Цель: устроить обмен книгами для 20 семей."), message("history-2", "assistant", "Нужны место, учёт и правило безопасности."), message("history-3", "user", "Место — библиотека; учёт по жанрам; повреждённые книги откладываем."), message("history-4", "assistant", "Добавить подписанные коробки, ответственного за приём и отдельную полку для проверки."), message("question", "user", "Составь план и не забудь условие про повреждённые книги.")], { index: 1, contextStrategy: "sliding_window", contextWindowSize: 2 }),
    lane("summary", "Сводка + последние сообщения", [message("history-1", "user", "Цель: устроить обмен книгами для 20 семей."), message("history-2", "assistant", "Нужны место, учёт и правило безопасности."), message("history-3", "user", "Место — библиотека; учёт по жанрам; повреждённые книги откладываем."), message("history-4", "assistant", "Добавить подписанные коробки, ответственного за приём и отдельную полку для проверки."), message("question", "user", "Составь план и не забудь условие про повреждённые книги.")], { index: 2, contextStrategy: "summary_window", contextWindowSize: 2, summary: "Обмен рассчитан на 20 семей; площадка — библиотека; сортировка по жанрам. Повреждённые книги откладываются для отдельной проверки." }),
  ]),
  board(10, "День 10 · Sticky Facts и ветвление", [
    lane("facts-main", "Факты · общий checkpoint", [message("goal", "user", "Готовим районный книжный обмен на 20 семей."), message("checkpoint", "assistant", "Известно: обмен в библиотеке, сбор до пятницы. Проверь постоянные факты через MCP, затем предложи добавить подтверждённое ограничение о хранении книг только на неделю.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
    lane("facts-branch", "Ветка · проверка альтернативы", [message("goal", "user", "Готовим районный книжный обмен на 20 семей."), message("checkpoint", "assistant", "Известно: обмен в библиотеке, сбор до пятницы. Проверь постоянные факты через MCP, затем предложи добавить подтверждённое ограничение о хранении книг только на неделю."), message("branch-task", "user", "Если место сбора изменится на читальный зал, какие постоянные факты нужно перепроверить? Не меняй память без моего подтверждения.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507", origin: { laneExternalId: "facts-main", messageExternalId: "checkpoint", kind: "branch" } }),
  ]),
  board(11, "День 11 · История и память доски", [
    lane("transcript", "Короткая память · transcript", [message("old", "user", "Цель: собрать 30 книг. Хранить их можно не больше недели."), message("next", "user", "Найди через history_search/history_get срок хранения в полном transcript и предложи следующий шаг. Объясни, почему его нет в отправленном окне контекста.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507", contextStrategy: "sliding_window", contextWindowSize: 1 }),
    lane("memory", "Working + longTerm · approval", [message("prompt", "user", "Прочитай память доски в слоях working и longTerm. Сравни, что относится к этой акции, а что является общим правилом клуба. Затем предложи добавить один новый факт через MCP: запись должна ждать моего подтверждения.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(12, "День 12 · Персонализация текстом AGENTS", [
    lane("concise", "Координатор · краткий формат", [message("task", "user", "Составь план сортировки 30 книг для 2 волонтёров.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507", instructionMode: "override", instructions: "Ты координатор волонтёров. Отвечай по-русски кратко: сначала 3 пронумерованных действия, затем один риск и его проверка. Учитывай, что волонтёров ровно двое; не придумывай дополнительные ресурсы." }),
    lane("accessible", "Библиотекарь · объяснение новичку", [message("task", "user", "Составь план сортировки 30 книг для 2 волонтёров.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507", instructionMode: "override", instructions: "Ты библиотекарь и объясняешь новичку. Используй простые русские слова, поясняй библиотечные термины в скобках и предлагай действия по одному за раз. Учитывай, что волонтёров ровно двое; не придумывай дополнительные ресурсы." }),
  ]),
  board(13, "День 13 · Задачи через MCP и UI", [
    lane("tasks-mcp", "Предложение MCP · с подтверждением", [message("task", "user", "Прочитай задачи доски. Для задачи о книжном обмене предложи записать в шаг: проверить коробки по жанрам. Объясни ожидаемое действие и дождись подтверждения пользователя.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
    lane("tasks-ui", "Состояние · продолжение", [message("task", "user", "Прочитай сохранённую задачу и перечисли её текущий этап, шаг и ожидаемое действие. После подтверждения изменения прочитай задачу повторно и сравни состояния.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(14, "День 14 · Инварианты как инструкции", [
    lane("invariant-demo", "Правила в AGENTS-тексте", [message("task", "user", "Предложи план книжного обмена. Проверь его по правилам доски и отдельно отметь любые противоречия или неизвестные факты.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507", instructionMode: "override", instructions: "Правила проекта: (1) не обещай срок хранения книг дольше одной недели; (2) повреждённые книги откладывай для отдельной проверки; (3) у каждого шага должен быть ответственный. Перед ответом перечисли противоречия и неизвестные сведения. Это инструкции для модели: они не являются жёсткой проверкой платформы; проверь результат вручную." }),
  ], []),
  board(15, "День 15 · Этапы задачи и подтверждение", [
    lane("lifecycle-mcp", "Предложение MCP · approval", [message("task", "user", "Прочитай задачу об обмене книгами и составленный план. Если план полный, предложи отдельно утвердить его; не переходи на следующий этап без подтверждения.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
    lane("lifecycle-ui", "Planning → execution → validation", [message("task", "user", "Сверь этап задачи и попробуй пройти только один разрешённый переход после утверждения плана. Покажи шаг, ожидаемое действие и состояние паузы.")], { index: 1, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(16, "День 16 · Подключение и каталог MCP", [
    lane("catalog", "Каталог локального MCP", [], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(17, "День 17 · Настоящий вызов MCP tool", [
    lane("tool-call", "Вызов read-only инструмента", [message("task", "user", "Вызови инструмент lookup_demo_event сервера ai-advent-demo для события spring-book-swap. Перескажи только возвращённые поля и отдельно укажи, что это статический локальный mock, а не реальное событие.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(18, "День 18 · Платформенное расписание", [
    lane("scheduler", "Запрос для сценария расписания", [message("task", "user", "Предложи безопасную задачу для одноразового расписания, которая соберёт демонстрационные локальные метрики. Укажи, какой результат я должен проверить после выполнения.")], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(19, "День 19 · Цепочка MCP-инструментов", [
    lane("pipeline", "Поиск → сводка → файл", [], { index: 0, model: "qwen/qwen3-30b-a3b-instruct-2507" }),
  ]),
  board(20, "День 20 · Агент и несколько MCP-серверов", [
    lane("orchestration", "Агент выбирает инструменты", [], {
      index: 0,
      model: "qwen/qwen3-30b-a3b-instruct-2507",
      instructionMode: "append",
      instructions: "Для запросов о демонстрационных событиях используй доступные MCP-инструменты. Сначала найди события через demo-events/search_events, затем передай полученные события в demo-events/summarize_events. Если пользователь просит сохранить сводку, передай её в demo-notes/save_summary на другом сервере. Не выдумывай результат инструментов и сообщи пользователю, если сохранение ждёт подтверждения.",
    }),
  ]),
  board(21, "День 21 · Индексация документов", [
    lane("indexing", "Корпус и две стратегии", [message("guide", "assistant", "Учебный CLI: `npm run rag -- index`, затем `compare`. Индекс и сравнение находятся в `v3/data/rag/classics/`; сообщения этой ленты сами индекс не создают.")], { index: 0 }),
  ]),
  board(22, "День 22 · Первый RAG-запрос", [
    lane("plain", "Без RAG", [message("guide", "assistant", "Запусти `npm run rag -- ask plain \"вопрос\"`. Контрольные вопросы — в `classics-questions.mjs`.")], { index: 0 }),
    lane("rag", "С RAG", [message("guide", "assistant", "Запусти `npm run rag -- ask rag \"вопрос\"`; для сравнения 10 вопросов — `eval`. Индекс нужен заранее.")], { index: 1 }),
  ]),
  board(23, "День 23 · Фильтрация и переформулировка", [
    lane("filter", "До и после фильтра", [message("guide", "assistant", "Команда `eval` сравнивает исходные top-K и результаты после порога, лексической переоценки и переформулировки коротких вопросов. Порог задаёт RAG_THRESHOLD.")], { index: 0 }),
  ]),
  board(24, "День 24 · Источники и отказ", [
    lane("citations", "Цитаты и слабый контекст", [message("guide", "assistant", "CLI сверяет source, section, chunk_id и дословность цитаты с найденным чанком. При пустой выдаче или невалидной цитате отвечает «не знаю». Смысловую согласованность отдельно оценивает `eval`.")], { index: 0 }),
  ]),
  board(25, "День 25 · RAG-чат с памятью задачи", [
    lane("chat", "История, цель и ограничения", [message("guide", "assistant", "Запусти `npm run rag -- chat demo`. Команды /goal, /constraint, /clarify и /term сохраняют состояние; `scenarios` проверяет два диалога по 12 ходов.")], { index: 0 }),
  ]),
  board(26, "День 26 · Запуск локальной LLM", [
    lane("local-start", "Ollama и три запроса", [message("guide", "assistant", "Открой [локальные модели](/?localDay=26). CLI: `npm run local -- status`, затем `probe`. Кнопки на отдельном экране отправляют реальные запросы Ollama; обычная лента этой доски остаётся карточкой-навигацией.")], { index: 0 }),
  ]),
  board(27, "День 27 · Локальная LLM в приложении", [
    lane("local-web", "Веб-чат без облака", [message("guide", "assistant", "Открой [локальный веб-чат](/?localDay=27). Запрос идёт через сервер v3 к Ollama на этом компьютере; API-ключ не нужен, облачного fallback нет.")], { index: 0 }),
  ]),
  board(28, "День 28 · Локальная LLM + RAG", [
    lane("local-rag", "Классика и локальные эмбеддинги", [message("guide", "assistant", "Открой [локальный RAG](/?localDay=28). Подготовка: `npm run local -- index`. Поиск и генерация работают локально. `benchmark` повторяет три вопроса дважды; `benchmark --cloud` явно включает сравнение с OpenRouter.")], { index: 0 }),
  ]),
];

await mkdir(output, { recursive: true });
for (const value of boards) {
  const day = Number(value.externalId.slice("ai-advent-day-".length));
  const target = join(output, `board-${String(day).padStart(2, "0")}.json`);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}
