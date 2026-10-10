import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ask, buildIndexes, chunkDocuments, citationCatalog, compareRetrieval, createOpenRouterClient, filterAndRerank, loadCorpus, localEmbedding, readIndex, rewriteQuestion, validateCitedAnswer, writeJsonAtomic } from "../examples/ai-advent/rag.mjs";
import { chatTurn, emptyChat, loadChat } from "../examples/ai-advent/rag-chat.mjs";
import { controlQuestions, longScenarios } from "../examples/ai-advent/rag-questions.mjs";

const doc = { source: "guide.md", title: "guide.md", text: "# Начало\nПервый раздел описывает импорт досок.\n\n## Память\nПамять задачи хранит цель и ограничения." };

test("корпус достигает 25 страниц и не включает data или секреты", async () => {
  const corpus = await loadCorpus();
  assert.ok(corpus.wordCount >= 10_000);
  assert.ok(corpus.documents.every(({ source }) => !/(?:^|\/)(?:data|\.env)(?:\/|$)/.test(source)));
});

test("оба способа разбиения сохраняют метаданные; структурный уважает заголовки", () => {
  const fixed = chunkDocuments([doc], "fixed");
  const structural = chunkDocuments([doc], "structural");
  assert.equal(fixed.length, 1);
  assert.equal(structural.length, 2);
  assert.deepEqual(structural.map((chunk) => chunk.section), ["Начало", "Память"]);
  assert.ok([...fixed, ...structural].every((chunk) => chunk.source && chunk.title && chunk.chunk_id && chunk.text));
});

test("индексы сохраняются отдельно и отклоняют устаревший корпус", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-rag-"));
  try {
    let calls = 0;
    const client = { embed: async (texts) => { calls++; return texts.map((text) => [text.length || 1, 1]); } };
    const report = await buildIndexes({ client, outputDirectory: directory });
    assert.ok(report.approximatePages >= 25);
    assert.ok(report.indexes.fixed.chunks > 0 && report.indexes.structural.chunks > 0);
    const index = await readIndex(join(directory, "structural.json"));
    assert.equal(index.chunks.length, report.indexes.structural.chunks);
    assert.ok(index.chunks.every((chunk) => chunk.vector.length === 2));
    assert.ok(calls > 0);
    calls = 0;
    await buildIndexes({ client, outputDirectory: directory });
    assert.equal(calls, 0, "Повторная сборка должна использовать уже оплаченные эмбеддинги из кеша");
    const stale = JSON.parse(await readFile(join(directory, "fixed.json"), "utf8"));
    stale.corpusDigest = "bad";
    await writeJsonAtomic(join(directory, "fixed.json"), stale);
    await assert.rejects(() => readIndex(join(directory, "fixed.json")), /изменились/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("поиск, фильтр и сравнение стратегий измеряют попадание источника", () => {
  const index = { chunks: [
    { ...doc, section: "Импорт", chunk_id: "a", vector: [1, 0] },
    { ...doc, source: "other.md", section: "Другое", chunk_id: "b", vector: [0, 1] },
  ] };
  const report = compareRetrieval({ fixed: index, structural: index }, [{ id: 1, sources: ["guide.md"] }], [[1, 0]], 1);
  assert.equal(report.fixed.hitAtK, 1);
  assert.equal(report.structural.hitAtK, 1);
  assert.equal(filterAndRerank([{ ...index.chunks[0], score: 0.2 }], "импорт", { threshold: 0.25 }).length, 0);
  assert.match(rewriteQuestion("Что дальше?", { goal: "Импорт досок" }), /Импорт досок/);
  assert.match(rewriteQuestion("Дай по одной цитате", { goal: "Сравнить два рассказа" }), /Сравнить два рассказа/);
  assert.deepEqual(localEmbedding("один и тот же текст"), localEmbedding("один и тот же текст"));
});

test("клиент отправляет пакет эмбеддингов и восстанавливает порядок по index", async () => {
  let request;
  const client = createOpenRouterClient("test-key", async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }] }) };
  });
  assert.deepEqual(await client.embed(["первый", "второй"]), [[1, 0], [0, 1]]);
  assert.equal(request.url, "https://openrouter.ai/api/v1/embeddings");
  assert.deepEqual(request.body.input, ["первый", "второй"]);
  assert.equal(request.headers.Authorization, "Bearer test-key");
});

test("цитаты принимаются только дословно из найденного чанка", () => {
  const chunk = { source: "guide.md", section: "Импорт", chunk_id: "a", text: "Импорт не перезаписывает историю доски." };
  const valid = { answer: "История сохраняется.", citations: [{ source: chunk.source, section: chunk.section, chunk_id: chunk.chunk_id, quote: "не перезаписывает историю" }] };
  assert.equal(validateCitedAnswer(valid, [chunk]).citations.length, 1);
  assert.throws(() => validateCitedAnswer({ ...valid, citations: [{ ...valid.citations[0], quote: "перезаписывает всё" }] }, [chunk]), /не совпадает/);
});

test("номера цитат подставляют точный текст и метаданные, неизвестные номера отклоняются", () => {
  const chunk = { source: "book.md", title: "Рассказ", section: "Глава", chunk_id: "a", text: "— Гайка-то? Мы из гаек грузила делаем…\nНа деревню дедушке.\n" + "Длинное предложение с пробелами ".repeat(30) };
  const catalog = citationCatalog([chunk]);
  assert.ok(catalog.length > 3);
  assert.ok(catalog.every((item) => chunk.text.includes(item.quote) && item.quote.length <= 360));
  const evidence = catalog.find((item) => item.quote.includes("грузила"));
  const result = validateCitedAnswer({ answer: "Для рыбалки.", citations: [{ evidence_id: evidence.evidence_id, quote: "выдуманный текст", source: "wrong.md" }] }, [chunk], catalog);
  assert.equal(result.citations[0].quote, evidence.quote);
  assert.equal(result.citations[0].source, "book.md");
  assert.throws(() => validateCitedAnswer({ answer: "Ответ", citations: [{ evidence_id: "unknown" }] }, [chunk], catalog), /Неизвестный номер/);
  assert.throws(() => validateCitedAnswer({ answer: "Ответ", citations: [{ evidence_id: evidence.evidence_id }] }, [chunk], [{ ...evidence, quote: "выдуманная цитата" }]), /не совпадает/);
});

test("ответ по номерам не требует перепечатывания цитат", async () => {
  const chunk = { ...doc, chunk_id: "a", section: "Начало", vector: [1, 0] };
  const client = { embed: async () => [[1, 0]], complete: async (messages) => {
    assert.match(messages[0].content, /Не перепечатывай цитаты/);
    assert.match(messages[1].content, /c1e1/);
    return JSON.stringify({ answer: "Есть импорт досок.", citations: [{ evidence_id: "c1e1" }] });
  } };
  const result = await ask({ client, index: { model: "fake", chunks: [chunk] }, question: "Что описано?" });
  assert.equal(result.abstained, false);
  assert.equal(result.repairCount, 0);
  assert.ok(chunk.text.includes(result.citations[0].quote));
});

test("ошибка номера не публикует черновик и отличается от отсутствия контекста", async () => {
  const client = { embed: async () => [[1, 0]], complete: async () => JSON.stringify({ answer: "Непроверенный ответ.", citations: [{ evidence_id: "bad" }] }) };
  const index = { model: "fake", chunks: [{ ...doc, chunk_id: "a", section: "Начало", vector: [1, 0] }] };
  const result = await ask({ client, index, question: "Что описано?" });
  assert.equal(result.abstained, true);
  assert.equal(result.refusalReason, "invalid_citation");
  assert.equal(result.draftAnswer, "Непроверенный ответ.");
  assert.notEqual(result.answer, result.draftAnswer);
  assert.equal(result.citations.length, 0);
});

test("при слабой выдаче модель не вызывается и возвращается просьба уточнить", async () => {
  let calls = 0;
  const client = { embed: async () => [[1, 0]], complete: async () => { calls++; return ""; } };
  const index = { model: "fake", chunks: [{ ...doc, chunk_id: "a", section: "Начало", vector: [0, 1] }] };
  const result = await ask({ client, index, question: "Несвязанный вопрос", threshold: 0.3 });
  assert.equal(result.abstained, true);
  assert.equal(result.refusalReason, "no_context");
  assert.match(result.answer, /Уточните/);
  assert.equal(calls, 0);
});

test("исправление цитаты получает конкретный неверный текст и исходный фрагмент", async () => {
  const chunk = { source: "guide.md", title: "Тест", section: "Цитата", chunk_id: "a", text: "Я его обрызгал! — подумал Червяков.", vector: [1, 0] };
  let calls = 0;
  const client = { embed: async () => [[1, 0]], complete: async (messages) => {
    calls++;
    if (calls === 2) {
      assert.match(messages.at(-1).content, /Я вас обрызгал/);
      assert.match(messages.at(-1).content, /Я его обрызгал/);
    }
    return JSON.stringify({ answer: "Червяков обрызгал генерала.", citations: [{ source: chunk.source, section: chunk.section, chunk_id: chunk.chunk_id, quote: calls === 1 ? "Я вас обрызгал!" : "Я его обрызгал!" }] });
  } };
  const result = await ask({ client, index: { model: "fake", chunks: [chunk] }, question: "Что произошло?" });
  assert.equal(result.abstained, false);
  assert.equal(result.repairCount, 1);
});

test("RAG передаёт найденный контекст и состояние задачи, затем проверяет цитату", async () => {
  const chunk = { source: "guide.md", title: "guide.md", section: "Память", chunk_id: "c1", text: "Цель задачи хранится отдельно от истории диалога.", vector: [1, 0] };
  let prompt = "";
  const client = {
    embed: async () => [[1, 0]],
    complete: async (messages) => {
      prompt = messages[1].content;
      return JSON.stringify({ answer: "Цель хранится отдельно.", citations: [{ source: chunk.source, section: chunk.section, chunk_id: chunk.chunk_id, quote: "Цель задачи хранится отдельно" }] });
    },
  };
  const result = await ask({ client, index: { model: "fake", chunks: [chunk] }, question: "Где цель?", threshold: 0.1, state: { goal: "Проверить память", constraints: ["Не терять цель"], clarifications: [], terms: {} }, history: [{ role: "user", content: "Уточнение пользователя" }] });
  assert.equal(result.abstained, false);
  assert.equal(result.citations[0].chunk_id, "c1");
  assert.match(prompt, /Проверить память/);
  assert.match(prompt, /Не терять цель/);
  assert.match(prompt, /Уточнение пользователя/);
});

test("два длинных сценария сохраняют цель, историю и источники", async () => {
  assert.equal(controlQuestions.length, 10);
  assert.deepEqual(longScenarios.map((scenario) => scenario.questions.length), [12, 12]);
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-chat-"));
  try {
    const chunk = { source: "guide.md", title: "guide.md", section: "Начало", chunk_id: "a", text: "История и цель сохраняются в локальном чате. Источник нужен для ответа.", vector: [1, 0] };
    const index = { model: "fake", chunks: [chunk] };
    const client = {
      embed: async () => [[1, 0]],
      complete: async () => JSON.stringify({ answer: "История и цель сохраняются.", citations: [{ source: chunk.source, section: chunk.section, chunk_id: chunk.chunk_id, quote: "История и цель сохраняются" }] }),
    };
    for (const scenario of longScenarios) {
      const path = join(directory, `${scenario.id}.json`);
      const chat = emptyChat();
      await chatTurn({ client, index, chat, input: `/goal ${scenario.goal}`, path });
      for (const constraint of scenario.constraints) await chatTurn({ client, index, chat, input: `/constraint ${constraint}`, path });
      for (const question of scenario.questions) {
        const result = await chatTurn({ client, index, chat, input: question, path });
        assert.equal(result.citations.length, 1);
      }
      const restored = await loadChat(path);
      assert.equal(restored.state.goal, scenario.goal);
      assert.equal(restored.history.length, 24);
      assert.deepEqual(restored.state.constraints, scenario.constraints);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
