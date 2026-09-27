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
  model: options.model ?? "openai/gpt-4o-mini",
  ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  ...(options.stop === undefined ? {} : { stop: options.stop }),
  contextStrategy: options.contextStrategy ?? "full",
  contextWindowSize: options.contextWindowSize ?? 10,
  contextBudgetTokens: options.contextBudgetTokens ?? 32768,
  ...(options.summary ? { summary: options.summary } : {}),
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
  board(1, "День 1 · Первый запрос", [lane("baseline", "Первый запрос", [message("task", "user", "Предложи один простой способ уменьшить количество пластиковых стаканчиков в офисе. Дай конкретный шаг и ожидаемый эффект.")], { index: 0 })]),
  board(2, "День 2 · Формат ответа", [
    lane("free", "Свободный формат", [message("setup", "user", "Ответь в свободном формате, без жёсткого ограничения длины."), message("setup-demo", "assistant", "Понял. Выберу структуру по смыслу.") , message("same-task", "user", task), message("answer-demo", "assistant", "Читатель находит книгу по каталогу и предъявляет её на стойке. Библиотекарь проверяет срок и оформляет выдачу. Возврат принимается в ящик или на стойке; просрочка блокирует новые выдачи до возврата.")], { index: 0 }),
    lane("constrained", "Формат, длина и stop", [message("setup", "user", "Отвечай ровно тремя строками с метками ДЕЙСТВИЕ:, ПРАВИЛО: и ИСКЛЮЧЕНИЕ:. Не более 45 слов всего. Закончи последовательностью <END> и после неё ничего не добавляй."), message("setup-demo", "assistant", "Формат принят; завершение ограничу маркером.") , message("same-task", "user", task), message("answer-demo", "assistant", "ДЕЙСТВИЕ: Читатель выбирает книгу по каталогу.\nПРАВИЛО: Библиотекарь проверяет срок и регистрирует выдачу.\nИСКЛЮЧЕНИЕ: Просрочка блокирует новые выдачи до возврата.\n<END>")], { index: 1, stop: "<END>" }),
  ]),
  board(3, "День 3 · Подходы к задаче", [
    lane("direct", "Прямой запрос", [message("task", "user", task), message("demo", "assistant", "Читатель выбирает книгу в каталоге, библиотекарь проверяет доступность и срок возврата, затем записывает выдачу. Просроченную книгу нужно вернуть до новой выдачи.")], { index: 0 }),
    lane("steps", "Краткие шаги", [message("task", "user", `${task}\nПокажи только краткие проверяемые шаги решения, без скрытых рассуждений.`), message("demo", "assistant", "1. Уточнить роли и событие выдачи.\n2. Задать проверку срока возврата.\n3. Учесть просрочку как крайний случай.")], { index: 1 }),
    lane("meta", "Улучшение запроса", [message("task", "user", `Сначала перепиши запрос так, чтобы явно задать роли, правила и крайний случай. Затем ответь по улучшенной версии. Запрос: ${task}`), message("demo", "assistant", "Уточнённый запрос добавил роли, срок, три правила и крайний случай. Пример ответа: читатель выбирает книгу; библиотекарь проверяет доступность, срок и просрочку.")], { index: 2 }),
    lane("experts", "Взгляд специалистов", [message("task", "user", `Сравни коротко взгляды библиотекаря, читателя и администратора на задачу. Затем дай единый вариант: ${task}`), message("demo", "assistant", "Библиотекарь отвечает за учёт, читатель — за ясные сроки, администратор — за исключения. Общее правило: выдача регистрируется с датой возврата; просрочка блокирует следующую выдачу.")], { index: 3, origin: { laneExternalId: "direct", messageExternalId: "task", kind: "branch" } }),
  ]),
  board(4, "День 4 · Температура", [
    lane("t0", "temperature 0", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 0, temperature: 0 }),
    lane("t07", "temperature 0.7", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 1, temperature: 0.7 }),
    lane("t12", "temperature 1.2", [message("task", "user", "Напиши одно нейтральное предложение-приглашение в городской парк, не более 18 слов.")], { index: 2, temperature: 1.2 }),
  ]),
  board(5, "День 5 · Каталог моделей", [
    lane("economy", "Экономичная · GPT-4o mini", [message("task", "user", "Одинаковая задача: составь короткий план из четырёх шагов для районного обмена книгами. Сравни качество, стоимость и параметры. Независимая переменная — модель; temperature=0.2, max_tokens=256.\n\n[Каталог моделей](https://openrouter.ai/models) · [карточка GPT-4o mini](https://openrouter.ai/openai/gpt-4o-mini)\nСнимок каталога на 2026-09-27: $0.15 / $0.60 за миллион входных / выходных токенов.")], { index: 0, model: "openai/gpt-4o-mini", temperature: 0.2, maxTokens: 256 }),
    lane("mid", "Средний уровень · DeepSeek V3", [message("task", "user", "Одинаковая задача: составь короткий план из четырёх шагов для районного обмена книгами. Сравни качество, стоимость и параметры. Независимая переменная — модель; temperature=0.2, max_tokens=256.\n\n[Каталог моделей](https://openrouter.ai/models) · [карточка DeepSeek V3](https://openrouter.ai/deepseek/deepseek-chat)\nСнимок каталога на 2026-09-27: около $0.26 / $1.03 за миллион входных / выходных токенов; цена зависит от маршрута.")], { index: 1, model: "deepseek/deepseek-chat", temperature: 0.2, maxTokens: 256 }),
    lane("premium", "Премиальная · Claude Sonnet 4", [message("task", "user", "Одинаковая задача: составь короткий план из четырёх шагов для районного обмена книгами. Сравни качество, стоимость и параметры. Независимая переменная — модель; temperature=0.2, max_tokens=256.\n\n[Каталог моделей](https://openrouter.ai/models) · [карточка Claude Sonnet 4](https://openrouter.ai/anthropic/claude-sonnet-4)\nСнимок каталога на 2026-09-27: $3 / $15 за миллион входных / выходных токенов.")], { index: 2, model: "anthropic/claude-sonnet-4", temperature: 0.2, maxTokens: 256 }),
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
];

await mkdir(output, { recursive: true });
for (const value of boards) {
  const day = Number(value.externalId.slice("ai-advent-day-".length));
  const target = join(output, `board-${String(day).padStart(2, "0")}.json`);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}
