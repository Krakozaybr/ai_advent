import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { buildOpenRouterRequest } from "../server/openrouter.mjs";
import { createSettingsStore } from "../server/settings.mjs";

function createMemorySettingsStore(initialApiKey = "") {
  let apiKey = initialApiKey;
  return {
    async getApiKey() {
      return apiKey;
    },
    async saveApiKey(nextApiKey) {
      apiKey = nextApiKey;
    },
  };
}

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("health endpoint reports that the server is ready", async () => {
  await withServer(createApp({ environmentApiKey: "" }), async (origin) => {
    const response = await fetch(`${origin}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("settings save the key without returning it to the browser", async () => {
  const app = createApp({
    settingsStore: createMemorySettingsStore(),
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const saveResponse = await fetch(`${origin}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-or-v1-test-key" }),
    });
    const saved = await saveResponse.json();
    const status = await (await fetch(`${origin}/api/settings`)).json();

    assert.deepEqual(saved, { hasApiKey: true, source: "saved" });
    assert.deepEqual(status, { hasApiKey: true, source: "saved" });
    assert.equal(JSON.stringify(status).includes("sk-or-v1-test-key"), false);
  });
});

test("settings store keeps the key in a private local file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-settings-"));
  const filePath = join(directory, "settings.json");

  try {
    const store = createSettingsStore(filePath);
    await store.saveApiKey("sk-or-v1-file-key");

    assert.equal(await store.getApiKey(), "sk-or-v1-file-key");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter request details expose JSON and query without the API key", () => {
  const request = buildOpenRouterRequest({
    model: "qwen/test",
    prompt: "Тест",
    maxTokens: 150,
    stop: "END",
  });

  assert.deepEqual(request, {
    method: "POST",
    url: "https://openrouter.ai/api/v1/chat/completions",
    query: {},
    json: {
      model: "qwen/test",
      messages: [{ role: "user", content: "Тест" }],
      max_tokens: 150,
      stop: ["END"],
    },
  });
  assert.equal(JSON.stringify(request).includes("apiKey"), false);
});

test("day 1 sends the prompt to the selected model", async () => {
  let receivedRequest;
  const requestLlm = async (request) => {
    receivedRequest = request;
    return {
      answer: "Тестовый ответ",
      model: request.model,
      usage: { total_tokens: 12 },
      cost: 0.000001,
      latencyMs: 25,
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day1/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Что такое LLM?", model: "qwen/test", maxTokens: 300 }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.answer, "Тестовый ответ");
    assert.deepEqual(receivedRequest, {
      apiKey: "test-secret-key",
      prompt: "Что такое LLM?",
      model: "qwen/test",
      maxTokens: 300,
    });
  });
});

test("day 2 runs free and controlled variants independently", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    return {
      answer:
        calls.length === 1
          ? "Ответ без заданных ограничений формата"
          : "Короткий управляемый ответ",
      model: request.model,
      usage: { total_tokens: 20 },
      cost: 0.000002,
      latencyMs: 30,
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const freeResponse = await fetch(`${origin}/api/day2/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant: "free",
        prompt: "Объясни замыкания.",
        model: "qwen/test",
      }),
    });
    const freeResult = await freeResponse.json();

    assert.equal(freeResponse.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      apiKey: "test-secret-key",
      model: "qwen/test",
      prompt: "Объясни замыкания.",
    });
    assert.equal(freeResult.variant, "free");
    assert.equal(freeResult.response.wordCount, 5);

    const controlledResponse = await fetch(`${origin}/api/day2/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant: "controlled",
        prompt: "Объясни замыкания. Не более 40 слов. В конце напиши END.",
        model: "qwen/test",
        maxTokens: 150,
        stop: "END",
      }),
    });
    const controlledResult = await controlledResponse.json();

    assert.equal(controlledResponse.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {
      apiKey: "test-secret-key",
      model: "qwen/test",
      prompt: "Объясни замыкания. Не более 40 слов. В конце напиши END.",
      maxTokens: 150,
      stop: "END",
    });
    assert.equal(controlledResult.variant, "controlled");
    assert.equal(controlledResult.response.wordCount, 3);
  });
});
