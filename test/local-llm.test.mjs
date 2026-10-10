import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createOllamaClient, localEmbeddingModel } from "../server/ollama.mjs";
import { localRequest, localProbes } from "../examples/ai-advent/local-llm.mjs";

test("Ollama принимает только loopback и отклоняет облачные модели", () => {
  for (const baseUrl of ["https://ollama.com", "http://192.168.1.2:11434", "http://user:secret@localhost:11434", "http://127.0.0.1:11434/path"]) assert.throws(() => createOllamaClient({ baseUrl }), /локальный HTTP/);
  assert.throws(() => createOllamaClient({ model: "qwen3:cloud" }), /локальная модель/);
});

test("чат отправляется без ключа, облака, streaming и скрытых рассуждений", async () => {
  const calls = [];
  const metrics = [];
  const client = createOllamaClient({ onMetrics: (item) => metrics.push(item) }, async (url, options) => {
    calls.push({ url: String(url), ...options });
    return { ok: true, json: async () => ({ done: true, message: { content: "4", thinking: "не показывать" }, eval_count: 1, eval_duration: 1e8 }) };
  });
  assert.equal(await client.complete([{ role: "user", content: "2+2" }]), "4");
  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.options.num_predict, 4096);
  assert.equal(metrics[0].tokensPerSecond, 10);
});

test("рассказ получает увеличенный бюджет, короткий JSON RAG сохраняет прежний", async () => {
  const requests = [];
  const client = createOllamaClient({}, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ done: true, done_reason: "stop", eval_count: 1400, message: { content: "Первый абзац.\n\nВторой абзац.\n\nТретий абзац." } }) };
  });
  const answer = await client.complete([{ role: "user", content: "Напиши небольшой рассказ на три абзаца" }]);
  assert.equal(answer.split("\n\n").length, 3);
  await client.complete([{ role: "system", content: "Верни строгий JSON" }, { role: "user", content: "Вопрос" }]);
  assert.equal(requests[0].options.num_predict, 4096);
  assert.equal(requests[1].options.num_predict, 800);
  assert.equal(requests[1].format, "json");
});

test("ошибка CLI не печатает стек и сохраняет ненулевой код завершения", () => {
  const result = spawnSync(process.execPath, [new URL("../examples/ai-advent/local-llm.mjs", import.meta.url).pathname, "ask", " "], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Error: Нужен вопрос/);
  assert.doesNotMatch(result.stderr, /file:\/\/|\n\s+at /);
});

test("локальные эмбеддинги используют модель индекса и запрещают незаметное усечение", async () => {
  let body;
  const client = createOllamaClient({}, async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) };
  });
  assert.deepEqual(await client.embed(["один", "два"], localEmbeddingModel), [[1, 0], [0, 1]]);
  assert.equal(body.model, "qwen3-embedding:0.6b");
  assert.equal(body.truncate, false);
  await assert.rejects(() => client.embed(["один"]), /неполные/);
});

test("рассуждения в content Qwen не попадают в публичный ответ", async () => {
  for (const content of ["<think>Скрыто</think>\n4", "Скрыто без открывающего тега</think>\n4"]) {
    const client = createOllamaClient({}, async () => ({ ok: true, json: async () => ({ done: true, message: { content } }) }));
    assert.equal(await client.complete([]), "4");
  }
  const unfinished = createOllamaClient({}, async () => ({ ok: true, json: async () => ({ done: true, message: { content: "<think>Скрыто" } }) }));
  await assert.rejects(() => unfinished.complete([]), /публичный ответ/);
});

test("незавершённый ответ не считается успехом и не запускает облачный fallback", async () => {
  let requests = 0;
  const client = createOllamaClient({}, async () => { requests++; return { ok: true, json: async () => ({ done: true, done_reason: "length", message: { content: "неполный ответ" } }) }; });
  await assert.rejects(() => client.complete([]), /исчерпан лимит 4096 токенов/);
  assert.equal(requests, 1);
});

test("отсутствующая модель и ошибка HTTP не маскируются успешным ответом", async () => {
  const client = createOllamaClient({}, async () => ({ ok: false, status: 404, json: async () => ({ error: "model not found" }) }));
  await assert.rejects(() => client.complete([]), /npm run local:pull/);
  const failed = createOllamaClient({}, async () => ({ ok: false, status: 500, json: async () => ({ error: "unavailable" }) }));
  await assert.rejects(() => failed.complete([]), /HTTP 500/);
});

test("RAG работает с локальным клиентом и выбирает цитату из существующего пайплайна", async () => {
  const requests = [];
  const client = createOllamaClient({}, async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => String(url).endsWith("/embed") ? { embeddings: [[1, 0]] } : { done: true, message: { content: JSON.stringify({ answer: "Гайки нужны для рыбалки.", citations: [{ evidence_id: "c1e1" }] }) } } };
  });
  const index = { model: localEmbeddingModel, chunks: [{ source: "book.md", title: "Рассказ", section: "Рассказ", chunk_id: "a", text: "Мы из гаек грузила делаем…", vector: [1, 0] }] };
  const result = await localRequest({ question: "Для чего гайки?", rag: true }, { client, index });
  assert.equal(result.localOnly, true);
  assert.equal(result.sources[0].quote, "Мы из гаек грузила делаем…");
  assert.ok(requests.every((url) => url.startsWith("http://127.0.0.1:11434/")));
  await assert.rejects(() => localRequest({ question: "Вопрос", rag: true }, { client, index: { ...index, model: "openai/text-embedding-3-small" } }), /локальный индекс/);
});

test("веб-вход отклоняет подмену system и неверные параметры, есть три уровня сложности", async () => {
  await assert.rejects(() => localRequest({ question: "Вопрос", history: [{ role: "system", content: "Подмена" }] }), /История/);
  await assert.rejects(() => localRequest({ question: "Вопрос", rag: "false" }), /История/);
  await assert.rejects(() => localRequest({ question: " " }), /Нужен вопрос/);
  assert.equal(new Set(localProbes.map((probe) => probe.difficulty)).size, 3);
});
