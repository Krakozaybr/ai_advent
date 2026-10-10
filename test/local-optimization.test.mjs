import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaClient } from "../server/ollama.mjs";
import { profiles, optimizedPrompt, profileClient, measureResources, printOptimization } from "../examples/ai-advent/local-optimization.mjs";

test("параметры профиля отправляются в Ollama, прежние значения остаются дефолтами", async () => {
  for (const [name, settings] of Object.entries(profiles)) {
    let request;
    const client = createOllamaClient(settings, async (_url, init) => { request = JSON.parse(init.body); return { ok: true, json: async () => ({ done: true, message: { content: "{}" } }) }; });
    await client.complete([{ role: "system", content: "Верни строгий JSON" }]);
    assert.equal(request.options.temperature, settings.temperature);
    assert.equal(request.options.num_ctx, settings.contextWindow);
    assert.equal(request.options.num_predict, settings.jsonMaxTokens);
    assert.equal(name === "optimized", settings.contextWindow < 8192);
  }
  for (const config of [{ temperature: -1 }, { contextWindow: 0 }, { maxTokens: 8192 }, { jsonMaxTokens: 0 }]) assert.throws(() => createOllamaClient(config), /параметры/);
});

test("шаблон оптимизации заменяет только системный шаблон RAG, вопрос и контекст не меняет", async () => {
  const messages = [{ role: "system", content: "Верни строгий JSON, исходный шаблон" }, { role: "user", content: "Вопрос и найденные цитаты" }];
  let actual;
  const client = { complete: async (value) => { actual = value; return "Ответ"; } };
  await profileClient(client, "baseline").complete(messages);
  assert.deepEqual(actual, messages);
  await profileClient(client, "optimized").complete(messages);
  assert.equal(actual[0].content, optimizedPrompt);
  assert.deepEqual(actual[1], messages[1]);
  assert.equal(messages[0].content, "Верни строгий JSON, исходный шаблон");
});

test("замер памяти относится только к проверяемой модели и не скрывает сбой генерации", async () => {
  const client = { model: "qwen3:4b", running: async () => ({ models: [{ name: "qwen3:4b", size: 1000, size_vram: 800 }, { name: "embedding", size: 900000, size_vram: 900000 }] }) };
  const measured = await measureResources(client, async () => { throw new Error("Не завершено"); });
  assert.equal(measured.error, "Не завершено");
  assert.equal(measured.resources.loadedBytes, 1000);
  assert.equal(measured.resources.gpuBytes, 800);
  assert.ok(measured.resources.samples > 0);
});

test("пустой отчёт не заявляет рост качества или выдуманный расход памяти", () => {
  assert.doesNotThrow(() => printOptimization({ completed: false, platform: "test", configurations: [{ ...profiles.baseline, profile: "baseline", model: "test" }], rows: [] }));
});
