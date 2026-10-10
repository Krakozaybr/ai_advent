import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOllamaClient, localEmbeddingModel } from "../../server/ollama.mjs";
import { ask, buildIndexes, createOpenRouterClient, readIndex, writeJsonAtomic } from "./rag.mjs";
import { controlQuestions } from "./classics-questions.mjs";
import { profileClient, profiles } from "./local-optimization.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const directory = join(root, "v3/data/rag/classics-ollama");
export const localProbes = [
  { id: 1, difficulty: "Простой", question: "Сколько будет 2 + 2? Ответь одним числом.", expected: "4" },
  { id: 2, difficulty: "Средний", question: "Объясни в двух предложениях разницу между индексом документов и поиском по нему.", expected: "Индекс создаётся заранее, поиск выбирает подходящие фрагменты для конкретного вопроса." },
  { id: 3, difficulty: "Сложный", question: "Книг 48. Треть отдали в первую библиотеку, половину оставшихся — во вторую. Сколько осталось? Покажи короткий расчёт.", expected: "48 − 16 = 32; 32 − 16 = 16." },
];

export async function localRequest({ question, rag = false, history = [], state = {}, profile = "baseline" }, { client, index } = {}) {
  if (typeof question !== "string" || !question.trim() || question.length > 6000) throw new Error("Нужен вопрос длиной от 1 до 6000 символов.");
  if (typeof rag !== "boolean" || !Array.isArray(history) || history.length > 20 || history.some((message) => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 6000)) throw new Error("История: до 20 сообщений user/assistant, до 6000 символов каждое; rag должен быть логическим значением.");
  history = history.map(({ role, content }) => ({ role, content }));
  if (!Object.hasOwn(profiles, profile)) throw new Error("Неизвестный профиль локальной модели.");
  const metrics = [];
  client ??= createOllamaClient({ ...(profile === "optimized" ? profiles.optimized : {}), onMetrics: (item) => metrics.push(item) });
  client = profileClient(client, profile);
  const started = performance.now();
  let result;
  if (rag) {
    index ??= await readIndex(join(directory, "structural.json")).catch((error) => { if (error.code === "ENOENT") throw new Error("Локального индекса пока нет. Выполни npm run local -- index."); throw error; });
    if (!index.model.startsWith("ollama/")) throw new Error("Для локального RAG нужен локальный индекс: npm run local -- index.");
    result = await ask({ client, index, question, history, state, threshold: 0.3 });
  } else {
    const answer = await client.complete([{ role: "system", content: "Отвечай по-русски, кратко. Не выдумывай факты. Если не знаешь, скажи об этом." }, ...history, { role: "user", content: question }]);
    result = { answer, citations: [], abstained: false };
  }
  return { answer: result.answer, sources: result.citations, abstained: result.abstained ?? false, refusalReason: result.refusalReason, localOnly: true, profile, settings: client.settings, model: client.model, endpoint: client.baseUrl, embeddingModel: rag ? index.model : undefined, elapsedMs: Math.round(performance.now() - started), metrics, retrieval: result.chosen?.map(({ source, section, chunk_id, score }) => ({ source, section, chunk_id, score })) ?? [] };
}

const printAnswer = (result) => {
  if (result.profile === "optimized" && result.settings) console.log(`Профиль: optimized · temperature=${result.settings.temperature} · контекст=${result.settings.contextWindow} · лимит JSON=${result.settings.jsonMaxTokens}`);
  console.log(`Модель: ${result.model}. Только локально: ${result.localOnly ? "да" : "нет"}. Время: ${result.elapsedMs} мс.\n\n${result.answer}`);
  for (const source of result.sources) console.log(`\nИсточник: ${source.title} · ${source.section} · ${source.chunk_id}\n«${source.quote}»`);
};

export async function runLocalCommand(command, args = []) {
  if (command === "optimize" || (command === "report" && args[0] === "29")) {
    const { optimizationCommand } = await import("./local-optimization.mjs");
    await optimizationCommand(command, args);
  } else if (command === "status") console.log(JSON.stringify(await createOllamaClient().status(), null, 2));
  else if (command === "index") {
    const report = await buildIndexes({ client: createOllamaClient(), model: localEmbeddingModel, corpusName: "classics", outputDirectory: directory, batchSize: 16, onProgress: console.log });
    console.log(`Локальный индекс готов: ${report.documents} произведений, ${report.indexes.structural.chunks} структурных фрагментов.`);
  } else if (command === "probe") {
    const rows = [];
    for (const probe of localProbes) {
      const result = await localRequest({ question: probe.question });
      rows.push({ ...probe, ...result });
      console.log(`\n${probe.difficulty} запрос: ${probe.question}\nОжидание: ${probe.expected}`);
      printAnswer(result);
    }
    await writeJsonAtomic(join(directory, "day26-probes.json"), { completed: true, createdAt: new Date().toISOString(), rows });
  } else if (["ask", "rag", "rag-optimized"].includes(command)) {
    printAnswer(await localRequest({ question: args.join(" "), rag: command !== "ask", profile: command === "rag-optimized" ? "optimized" : "baseline" }));
  } else if (command === "benchmark") {
    const index = await readIndex(join(directory, "structural.json"));
    const rows = [];
    const cloud = args.includes("--cloud");
    const local = createOllamaClient();
    const remote = cloud ? createOpenRouterClient(process.env.OPENROUTER_API_KEY ?? JSON.parse(await readFile(join(root, "data/settings.json"), "utf8").catch(() => "{}")).openRouterApiKey ?? "") : undefined;
    const clients = { local, ...(remote ? { cloud: { embed: (...values) => local.embed(...values), complete: (messages) => remote.complete(messages, process.env.RAG_ANSWER_MODEL ?? "openai/gpt-4.1-mini") } } : {}) };
    for (const question of controlQuestions.filter((item) => [4, 7, 8].includes(item.id))) {
      for (const [mode, client] of Object.entries(clients)) {
        for (let repeat = 1; repeat <= 2; repeat++) {
          const started = performance.now();
          try {
            const result = await ask({ client, index, question: question.question, threshold: 0.3 });
            rows.push({ id: question.id, question: question.question, expected: question.expected, mode, repeat, elapsedMs: Math.round(performance.now() - started), answer: result.answer, sources: result.citations, abstained: result.abstained ?? false, sourceHit: result.citations.some((citation) => question.sources.includes(citation.source)) });
          } catch (error) { rows.push({ id: question.id, question: question.question, expected: question.expected, mode, repeat, elapsedMs: Math.round(performance.now() - started), error: error.message }); }
          console.log(`Вопрос ${question.id} · ${mode === "local" ? "локально" : "облако"} · повтор ${repeat}/2 завершён`);
        }
      }
      await writeJsonAtomic(join(directory, "day28-benchmark.json"), { completed: false, model: local.model, embeddingModel: index.model, cloudModel: cloud ? process.env.RAG_ANSWER_MODEL ?? "openai/gpt-4.1-mini" : undefined, rows });
    }
    await writeJsonAtomic(join(directory, "day28-benchmark.json"), { completed: true, model: local.model, embeddingModel: index.model, cloudModel: cloud ? process.env.RAG_ANSWER_MODEL ?? "openai/gpt-4.1-mini" : undefined, rows });
    console.log("Отчёт готов: npm run local -- report 28");
  } else if (command === "report") {
    if (!["26", "28"].includes(args[0])) throw new Error("Укажи день: npm run local -- report 26 или report 28.");
    const report = JSON.parse(await readFile(join(directory, args[0] === "26" ? "day26-probes.json" : "day28-benchmark.json"), "utf8"));
    console.log(`Проверка ${report.completed ? "завершена" : "не завершена"}.`);
    if (args[0] === "26") for (const row of report.rows) { console.log(`\n${row.difficulty}: ${row.question}\nОжидание: ${row.expected}`); printAnswer(row); }
    else {
      for (const mode of [...new Set(report.rows.map((row) => row.mode))]) {
        const rows = report.rows.filter((row) => row.mode === mode);
        console.log(`\n${mode === "local" ? "Локальная модель" : "Облачная модель"}: ${mode === "local" ? report.model : report.cloudModel}\nУспешных запросов: ${rows.filter((row) => !row.error).length}/${rows.length}. С нужным источником: ${rows.filter((row) => row.sourceHit).length}/${rows.length}. Отказов: ${rows.filter((row) => row.abstained).length}. Среднее время: ${Math.round(rows.reduce((sum, row) => sum + row.elapsedMs, 0) / rows.length)} мс.`);
        const pairs = [...new Set(rows.map((row) => row.id))].map((id) => rows.filter((row) => row.id === id));
        console.log(`Одинаковый ответ в обоих повторах: ${pairs.filter((pair) => pair.length === 2 && pair.every((row) => !row.error && !row.abstained) && pair[0].answer === pair[1].answer).length}/${pairs.length} вопросов.`);
      }
      console.log("Качество проверяется по ожиданию и фактическим ответам; наличие источника не доказывает правильность. Время включает поиск, генерацию, проверку и возможное исправление цитат.");
      if (args.includes("--details")) for (const row of report.rows) console.log(`\n${row.question}\nОжидание: ${row.expected}\n${row.mode}, повтор ${row.repeat}: ${row.answer ?? row.error}\nИсточники: ${(row.sources ?? []).map((source) => `${source.title} · ${source.chunk_id}: «${source.quote}»`).join("; ") || "нет"}`);
    }
  } else if (command === "request") {
    let text = "";
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 130_000) throw new Error("Запрос слишком большой."); }
    const input = JSON.parse(text);
    console.log(JSON.stringify(await localRequest(input)));
  } else console.log("Команды: npm run local -- status | probe | index | ask \"вопрос\" | rag \"вопрос\" | rag-optimized \"вопрос\" | optimize [--all] [--quantization] | benchmark [--cloud] | report 26|28|29 [--details]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runLocalCommand(process.argv[2], process.argv.slice(3)); }
  catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
