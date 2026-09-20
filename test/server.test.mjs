import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LlmAgent } from "../server/agent.mjs";
import { createApp } from "../server/app.mjs";
import { createConversationStore } from "../server/conversation-store.mjs";
import { createMemoryStore } from "../server/memory-store.mjs";
import { buildOpenRouterRequest } from "../server/openrouter.mjs";
import { createSettingsStore } from "../server/settings.mjs";
import { estimateMessagesTokens } from "../server/token-counter.mjs";
import { DEFAULT_DAY3_TASK } from "../shared/day3.js";
import { DEFAULT_DAY4_PROMPT } from "../shared/day4.js";
import { DEFAULT_DAY5_PROMPT } from "../shared/day5.js";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../shared/day6.js";
import { DEFAULT_DAY7_SYSTEM_PROMPT } from "../shared/day7.js";
import {
  buildDay8OverflowPrompt,
  DEFAULT_DAY8_CONTEXT_LIMIT,
  getDay8ScriptPrompt,
} from "../shared/day8.js";
import {
  DEFAULT_DAY9_SYSTEM_PROMPT,
  getDay9ScriptPrompt,
} from "../shared/day9.js";
import {
  DEFAULT_DAY10_SYSTEM_PROMPT,
  getDay10ScriptPrompt,
} from "../shared/day10.js";
import { DEFAULT_DAY11_SYSTEM_PROMPT } from "../shared/day11.js";

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
    temperature: 0.7,
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
      temperature: 0.7,
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

test("day 3 runs a direct method and checks the expected answer", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    return {
      answer: "Краткое решение. Итоговый ответ: 453",
      model: request.model,
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      cost: 0.000004,
      latencyMs: 40,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day3/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "direct",
        task: DEFAULT_DAY3_TASK,
        instruction: "Дай прямой ответ.",
        model: "qwen/test",
        maxTokens: 300,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Дай прямой ответ/u);
    assert.equal(result.correct, true);
    assert.equal(result.expectedAnswer, "453");
    assert.equal(result.usage.total_tokens, 30);
  });
});

test("day 3 meta method creates a prompt and then solves with it", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    const answer =
      calls.length === 1
        ? "Реши систему условий для цифр числа и проверь сумму."
        : "Цифры равны 4, 5 и 3. Итоговый ответ: 453";
    return {
      answer,
      model: request.model,
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
      cost: 0.000003,
      latencyMs: 35,
      httpRequest: buildOpenRouterRequest({ ...request, prompt: request.prompt }),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day3/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "meta",
        task: DEFAULT_DAY3_TASK,
        instruction: "Сначала создай prompt.",
        model: "qwen/test",
        maxTokens: 300,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /Реши систему условий/u);
    assert.equal(
      result.generatedPrompt,
      "Реши систему условий для цифр числа и проверь сумму.",
    );
    assert.equal(result.correct, true);
    assert.equal(result.usage.total_tokens, 50);
    assert.equal(result.cost, 0.000006);
    assert.equal(result.latencyMs, 70);
    assert.equal(result.calls.length, 2);
  });
});

test("day 4 sends temperature and calculates comparison metrics", async () => {
  let receivedRequest;
  const requestLlm = async (request) => {
    receivedRequest = request;
    return {
      answer: `1. Название: Учебный ритм
   Слоган: Планируй спокойно
   Польза: Помогает распределить задания.

2. Название: Верный план
   Слоган: Всё вовремя
   Польза: Напоминает о важных сроках.

3. Название: Шаг за шагом
   Слоган: Учись без спешки
   Польза: Делит большие цели на задачи.`,
      model: request.model,
      usage: { total_tokens: 90 },
      cost: 0.00001,
      latencyMs: 120,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day4/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: DEFAULT_DAY4_PROMPT,
        model: "qwen/test",
        maxTokens: 550,
        temperature: 1.2,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(receivedRequest, {
      apiKey: "test-secret-key",
      prompt: DEFAULT_DAY4_PROMPT,
      model: "qwen/test",
      maxTokens: 550,
      temperature: 1.2,
    });
    assert.equal(result.temperature, 1.2);
    assert.equal(result.formatCorrect, true);
    assert.equal(result.formatDetails.labels.names, 3);
    assert.ok(result.lexicalDiversity > 0);
    assert.equal(result.httpRequest.json.temperature, 1.2);

    const invalidResponse = await fetch(`${origin}/api/day4/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: DEFAULT_DAY4_PROMPT,
        model: "qwen/test",
        maxTokens: 550,
        temperature: "",
      }),
    });

    assert.equal(invalidResponse.status, 400);
    assert.deepEqual(await invalidResponse.json(), {
      error: "temperature должна быть числом от 0 до 2.",
    });
  });
});

test("day 5 measures a selected model and checks the default answer", async () => {
  let receivedRequest;
  const requestLlm = async (request) => {
    receivedRequest = request;
    return {
      answer: `\`\`\`js
function firstUniqueCharacter(text) {
  const characters = Array.from(text);
  const counts = new Map();
  for (const character of characters) {
    counts.set(character, (counts.get(character) || 0) + 1);
  }
  return characters.find((character) => counts.get(character) === 1) ?? null;
}
\`\`\`

Результат для примера: «к». Сложность — O(n).`,
      model: request.model,
      usage: { total_tokens: 140 },
      cost: 0.00002,
      latencyMs: 180,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day5/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: DEFAULT_DAY5_PROMPT,
        model: "qwen/test-strong",
        maxTokens: 700,
        temperature: 0,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(receivedRequest, {
      apiKey: "test-secret-key",
      prompt: DEFAULT_DAY5_PROMPT,
      model: "qwen/test-strong",
      maxTokens: 700,
      temperature: 0,
    });
    assert.equal(result.qualityCheck.score, 5);
    assert.equal(result.qualityCheck.total, 5);
    assert.equal(result.httpRequest.json.model, "qwen/test-strong");
    assert.equal(result.httpRequest.json.temperature, 0);
  });
});

test("LlmAgent encapsulates messages and keeps runtime history", async () => {
  const calls = [];
  const agent = new LlmAgent({
    apiKey: "test-secret-key",
    model: "qwen/test",
    maxTokens: 300,
    temperature: 0.7,
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    requestLlm: async (request) => {
      calls.push(request);
      return {
        answer: calls.length === 1 ? "Первый ответ" : "Второй ответ",
        model: request.model,
        usage: { total_tokens: 20 },
        cost: 0.000002,
        latencyMs: 30,
      };
    },
  });

  await agent.respond("Первый вопрос");
  await agent.respond("Второй вопрос");

  assert.deepEqual(
    calls[0].messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.deepEqual(
    calls[1].messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "Первый вопрос" },
    { role: "assistant", content: "Первый ответ" },
    { role: "user", content: "Второй вопрос" },
    { role: "assistant", content: "Второй ответ" },
  ]);
});

test("day 6 calls the LlmAgent through the HTTP API", async () => {
  let receivedRequest;
  const requestLlm = async (request) => {
    receivedRequest = request;
    return {
      answer: "HTTP API работает через сеть, а функция вызывается внутри программы.",
      model: request.model,
      usage: { total_tokens: 32 },
      cost: 0.000003,
      latencyMs: 45,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day6/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "Тестовый агент",
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        message: "Чем API отличается от функции?",
        model: "qwen/test",
        maxTokens: 300,
        temperature: 0.7,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result.agent, { name: "Тестовый агент", type: "LlmAgent" });
    assert.equal(result.input, "Чем API отличается от функции?");
    assert.equal(result.response.wordCount, 10);
    assert.deepEqual(receivedRequest.messages, [
      { role: "system", content: DEFAULT_AGENT_SYSTEM_PROMPT },
      { role: "user", content: "Чем API отличается от функции?" },
    ]);
    assert.deepEqual(result.response.httpRequest.json.messages, receivedRequest.messages);
  });
});

test("SQLite conversation store restores messages after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-history-"));
  const filePath = join(directory, "agent.sqlite");
  let store = createConversationStore(filePath);

  try {
    store.appendExchange("dialog", "Запомни JavaScript", "Я запомнил JavaScript");
    store.close();

    store = createConversationStore(filePath);
    const messages = store.listMessages("dialog");

    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "Запомни JavaScript" },
        { role: "assistant", content: "Я запомнил JavaScript" },
      ],
    );
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("day 7 sends restored SQLite history after an application restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-day7-"));
  const filePath = join(directory, "agent.sqlite");
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    return {
      answer: calls.length === 1 ? "Я запомнил JavaScript." : "Твой любимый язык — JavaScript.",
      model: request.model,
      usage: { total_tokens: 42 },
      cost: 0.000004,
      latencyMs: 50,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const requestBody = {
    agentName: "Агент с памятью",
    systemPrompt: DEFAULT_DAY7_SYSTEM_PROMPT,
    model: "qwen/test",
    maxTokens: 300,
    temperature: 0.7,
  };
  let store = createConversationStore(filePath);

  try {
    await withServer(
      createApp({
        conversationStore: store,
        settingsStore: createMemorySettingsStore("test-secret-key"),
        requestLlm,
        environmentApiKey: "",
      }),
      async (origin) => {
        const response = await fetch(`${origin}/api/day7/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, message: "Запомни JavaScript" }),
        });

        assert.equal(response.status, 200);
        assert.equal((await response.json()).history.length, 2);
      },
    );

    store.close();
    store = createConversationStore(filePath);

    await withServer(
      createApp({
        conversationStore: store,
        settingsStore: createMemorySettingsStore("test-secret-key"),
        requestLlm,
        environmentApiKey: "",
      }),
      async (origin) => {
        const historyBefore = await (await fetch(`${origin}/api/day7/history`)).json();
        assert.equal(historyBefore.messages.length, 2);

        const response = await fetch(`${origin}/api/day7/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, message: "Какой язык я люблю?" }),
        });
        const result = await response.json();

        assert.equal(response.status, 200);
        assert.equal(result.history.length, 4);
        assert.deepEqual(receivedMessages(calls[1]), [
          { role: "system", content: DEFAULT_DAY7_SYSTEM_PROMPT },
          { role: "user", content: "Запомни JavaScript" },
          { role: "assistant", content: "Я запомнил JavaScript." },
          { role: "user", content: "Какой язык я люблю?" },
        ]);
      },
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("token estimate grows together with the dialogue history", () => {
  const shortHistory = [
    { role: "user", content: getDay8ScriptPrompt("short", 0) },
    { role: "assistant", content: "Запомнил." },
  ];
  const longHistory = Array.from({ length: 8 }, (_, index) => [
    { role: "user", content: getDay8ScriptPrompt("long", index) },
    { role: "assistant", content: "Запомнил требование." },
  ]).flat();
  const shortEstimate = estimateMessagesTokens(shortHistory);
  const longEstimate = estimateMessagesTokens(longHistory);
  const overflowEstimate = estimateMessagesTokens([
    ...shortHistory,
    { role: "user", content: buildDay8OverflowPrompt() },
  ]);

  assert.ok(shortEstimate > 0);
  assert.ok(longEstimate > shortEstimate);
  assert.ok(overflowEstimate > longEstimate);
});

test("day 8 overflow prompt is a meaningful stack trace beyond the model limit", () => {
  const prompt = buildDay8OverflowPrompt();

  assert.match(prompt, /Объясни, в чём ошибка/u);
  assert.match(prompt, /payments-api/u);
  assert.match(prompt, /configured-port=5432; expected-port=6432/u);
  assert.match(prompt, /request-001000/u);
  assert.ok(
    estimateMessagesTokens([{ role: "user", content: prompt }]) >
      DEFAULT_DAY8_CONTEXT_LIMIT,
  );
});

test("day 8 enables OpenRouter compression for the overflow request", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    if (
      request.messages.some((message) => message.content.length > 500) &&
      !request.plugins?.some((plugin) => plugin.id === "context-compression")
    ) {
      throw new Error("OpenRouter: context length exceeded");
    }
    return {
      answer: "AI Advent — локальный учебный проект с десятью вкладками.",
      model: request.model,
      usage: { prompt_tokens: 135, completion_tokens: 18, total_tokens: 153 },
      cost: 0.000012,
      latencyMs: 55,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });
  const baseBody = {
    systemPrompt: DEFAULT_DAY7_SYSTEM_PROMPT,
    prompt: getDay8ScriptPrompt("short", 0),
    history: [],
    model: "qwen/test",
    maxTokens: 180,
    contextLimit: 1200,
    temperature: 0.2,
  };

  await withServer(app, async (origin) => {
    const shortResponse = await fetch(`${origin}/api/day8/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, scenario: "short" }),
    });
    const shortResult = await shortResponse.json();

    assert.equal(shortResponse.status, 200);
    assert.equal(shortResult.failed, false);
    assert.equal(shortResult.sent, true);
    assert.equal(shortResult.tokenCounts.actualInput, 135);
    assert.equal(shortResult.tokenCounts.actualResponse, 18);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages.length, 2);

    const longResponse = await fetch(`${origin}/api/day8/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        scenario: "long",
        history: [
          { role: "user", content: getDay8ScriptPrompt("long", 0) },
          { role: "assistant", content: "Запомнил первое требование." },
          { role: "user", content: getDay8ScriptPrompt("long", 1) },
          { role: "assistant", content: "Запомнил второе требование." },
        ],
        prompt: getDay8ScriptPrompt("long", 2),
      }),
    });
    const longResult = await longResponse.json();

    assert.equal(longResponse.status, 200);
    assert.equal(longResult.failed, false);
    assert.equal(longResult.historyMessages, 4);
    assert.ok(longResult.tokenCounts.estimatedInput > shortResult.tokenCounts.estimatedInput);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].messages.length, 6);

    const overflowPrompt = buildDay8OverflowPrompt();

    const overflowResponse = await fetch(`${origin}/api/day8/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        scenario: "overflow",
        contextLimit: DEFAULT_DAY8_CONTEXT_LIMIT,
        history: [
          { role: "user", content: getDay8ScriptPrompt("overflow", 0) },
          { role: "assistant", content: "Запомнил факт об изменении порта." },
        ],
        prompt: overflowPrompt,
      }),
    });
    const overflowResult = await overflowResponse.json();

    assert.equal(overflowResponse.status, 200);
    assert.equal(overflowResult.sent, true);
    assert.equal(overflowResult.failed, false);
    assert.equal(overflowResult.compressionEnabled, true);
    assert.equal(overflowResult.exceedsLimit, true);
    assert.ok(
      overflowResult.tokenCounts.estimatedWithResponse >
        overflowResult.tokenCounts.contextLimit,
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2].messages.at(-1).content, overflowPrompt);
    assert.deepEqual(calls[2].plugins, [{ id: "context-compression" }]);
    assert.equal(calls[2].timeoutMs, 120_000);
    assert.deepEqual(overflowResult.httpRequest.json.plugins, [
      { id: "context-compression" },
    ]);
    assert.match(overflowResult.httpRequest.note, /отправлен в OpenRouter/u);
  });
});

test("day 9 replaces old messages with a separate summary and keeps the last N", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    const isSummary = request.messages[0].content.includes("обновляешь краткую память");
    const isCompressed = request.messages.some((message) =>
      message.content.startsWith("Summary старой части диалога:"),
    );

    if (isSummary) {
      return {
        answer: "- Проект называется AI Advent.\n- Приложение запускается локально и содержит 10 вкладок.",
        model: request.model,
        usage: { prompt_tokens: 80, completion_tokens: 24, total_tokens: 104 },
        cost: 0.00001,
        latencyMs: 20,
        httpRequest: buildOpenRouterRequest(request),
      };
    }

    return {
      answer: isCompressed
        ? "AI Advent: локальный проект с 10 вкладками, OpenRouter и Qwen."
        : "AI Advent: локальный проект с 10 вкладками, OpenRouter и Qwen.",
      model: request.model,
      usage: isCompressed
        ? { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 }
        : { prompt_tokens: 210, completion_tokens: 20, total_tokens: 230 },
      cost: 0.00002,
      latencyMs: 30,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const history = [
    { role: "user", content: getDay9ScriptPrompt(0) },
    { role: "assistant", content: "Запомнил название проекта." },
    { role: "user", content: getDay9ScriptPrompt(1) },
    { role: "assistant", content: "Запомнил способ запуска и число вкладок." },
    { role: "user", content: getDay9ScriptPrompt(2) },
    { role: "assistant", content: "Запомнил OpenRouter и Qwen." },
  ];
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/day9/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: DEFAULT_DAY9_SYSTEM_PROMPT,
        message: getDay9ScriptPrompt(3),
        model: "qwen/test",
        maxTokens: 300,
        summaryMaxTokens: 220,
        keepLast: 4,
        temperature: 0.2,
        fullHistory: history,
        compressedHistory: history,
        summary: "",
        summarizedMessageCount: 0,
      }),
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result.agent, { name: "ContextCompressionAgent", type: "agent" });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].temperature, 0);
    assert.equal(calls[1].messages.length, 8);
    assert.equal(calls[2].messages.length, 7);
    assert.equal(result.summary.summarizedNow, 2);
    assert.equal(result.summary.summarizedMessageCount, 2);
    assert.equal(result.summary.keptRecentMessages, 4);
    assert.match(result.summary.text, /AI Advent/u);
    assert.equal(result.tokenCounts.actualFullInput, 210);
    assert.equal(result.tokenCounts.actualCompressedInput, 120);
    assert.equal(result.tokenCounts.actualSaved, 90);
    assert.equal(
      result.responses.compressed.httpRequest.json.messages[1].role,
      "system",
    );
    assert.match(
      result.responses.compressed.httpRequest.json.messages[1].content,
      /Summary старой части диалога/u,
    );
  });
});

test("day 10 builds different contexts for sliding, facts and branching", async () => {
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    const isFactExtraction = request.messages[0].content.includes("Sticky Facts агента");
    if (isFactExtraction) {
      return {
        answer: "```json\n{\"project\":\"AI Advent\",\"budget\":\"50 долларов\"}\n```",
        model: request.model,
        usage: { prompt_tokens: 55, completion_tokens: 18, total_tokens: 73 },
        cost: 0.00001,
        latencyMs: 15,
        httpRequest: buildOpenRouterRequest(request),
      };
    }
    return {
      answer: "Требование принято.",
      model: request.model,
      usage: { prompt_tokens: request.messages.length * 20, completion_tokens: 8, total_tokens: request.messages.length * 20 + 8 },
      cost: 0.00002,
      latencyMs: 25,
      httpRequest: buildOpenRouterRequest(request),
    };
  };
  const history = Array.from({ length: 3 }, (_, index) => [
    { role: "user", content: getDay10ScriptPrompt("sliding", index) },
    { role: "assistant", content: `Запомнил требование ${index + 1}.` },
  ]).flat();
  const app = createApp({
    settingsStore: createMemorySettingsStore("test-secret-key"),
    requestLlm,
    environmentApiKey: "",
  });
  const baseBody = {
    branchId: "main",
    systemPrompt: DEFAULT_DAY10_SYSTEM_PROMPT,
    message: getDay10ScriptPrompt("sliding", 3),
    model: "qwen/test",
    keepLast: 4,
    maxTokens: 320,
    factsMaxTokens: 260,
    temperature: 0.2,
    history,
    facts: {},
  };

  await withServer(app, async (origin) => {
    const slidingResponse = await fetch(`${origin}/api/day10/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, strategy: "sliding" }),
    });
    const sliding = await slidingResponse.json();

    assert.equal(slidingResponse.status, 200);
    assert.equal(sliding.strategy, "sliding");
    assert.equal(sliding.context.totalHistoryMessages, 6);
    assert.equal(sliding.context.sentHistoryMessages, 4);
    assert.equal(calls[0].messages.length, 6);
    assert.ok(sliding.tokenCounts.estimatedSentInput < sliding.tokenCounts.estimatedFullInput);

    const factsResponse = await fetch(`${origin}/api/day10/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, strategy: "facts" }),
    });
    const facts = await factsResponse.json();

    assert.equal(factsResponse.status, 200);
    assert.equal(facts.strategy, "facts");
    assert.deepEqual(facts.facts, { project: "AI Advent", budget: "50 долларов" });
    assert.equal(calls[1].temperature, 0);
    assert.equal(calls[2].messages.length, 7);
    assert.match(calls[2].messages[1].content, /Sticky Facts/u);
    assert.equal(facts.context.factsCount, 2);

    const branchingResponse = await fetch(`${origin}/api/day10/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        strategy: "branching",
        branchId: "branch-a",
      }),
    });
    const branching = await branchingResponse.json();

    assert.equal(branchingResponse.status, 200);
    assert.equal(branching.strategy, "branching");
    assert.equal(branching.branchId, "branch-a");
    assert.equal(branching.context.sentHistoryMessages, history.length);
    assert.equal(calls[3].messages.length, history.length + 2);
    assert.equal(branching.tokenCounts.estimatedSaved, 0);
  });
});

test("day 11 stores three memory layers separately and compares equal prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-advent-day11-"));
  const filePath = join(directory, "agent.sqlite");
  const scopeId = "day11-default";
  const memoryStore = createMemoryStore(filePath);
  const calls = [];
  const requestLlm = async (request) => {
    calls.push(request);
    const hasMemory = request.messages.length > 2;
    return {
      answer: hasMemory
        ? "План на JavaScript с дедлайном в пятницу."
        : "Уточните стек и срок проекта.",
      model: request.model,
      usage: {
        prompt_tokens: hasMemory ? 90 : 25,
        completion_tokens: 12,
        total_tokens: hasMemory ? 102 : 37,
      },
      cost: 0.00001,
      latencyMs: 20,
      httpRequest: buildOpenRouterRequest(request),
    };
  };

  try {
    memoryStore.upsertItem(scopeId, "shortTerm", "request", "Подготовить план проекта");
    memoryStore.upsertItem(scopeId, "working", "deadline", "Пятница");
    memoryStore.upsertItem(scopeId, "longTerm", "stack", "JavaScript");

    const app = createApp({
      settingsStore: createMemorySettingsStore("test-secret-key"),
      memoryStore,
      requestLlm,
      environmentApiKey: "",
    });

    await withServer(app, async (origin) => {
      const initialState = await (await fetch(`${origin}/api/day11/state`)).json();
      assert.equal(initialState.layers.shortTerm[0].key, "request");
      assert.equal(initialState.layers.working[0].key, "deadline");
      assert.equal(initialState.layers.longTerm[0].key, "stack");

      const response = await fetch(`${origin}/api/day11/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemPrompt: DEFAULT_DAY11_SYSTEM_PROMPT,
          message: "Составь короткий план.",
          model: "qwen/test",
          maxTokens: 300,
          temperature: 0.2,
        }),
      });
      const result = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(result.agent, { name: "MemoryLayerAgent", type: "agent" });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].messages.length, 2);
      assert.equal(calls[1].messages.length, 5);
      assert.equal(calls[0].messages.at(-1).content, calls[1].messages.at(-1).content);
      assert.match(calls[1].messages[1].content, /Краткосрочные записи/u);
      assert.match(calls[1].messages[2].content, /Рабочая память/u);
      assert.match(calls[1].messages[3].content, /Долговременная память/u);
      assert.equal(result.state.messages.length, 2);
      assert.equal(result.responses.withMemory.answer, "План на JavaScript с дедлайном в пятницу.");
      assert.equal(result.tokenCounts.actualWithoutMemory, 25);
      assert.equal(result.tokenCounts.actualWithMemory, 90);
    });

    memoryStore.close();
    const reopenedStore = createMemoryStore(filePath);
    const persisted = reopenedStore.getState(scopeId);
    assert.equal(persisted.messages.length, 2);
    assert.equal(persisted.layers.shortTerm[0].value, "Подготовить план проекта");
    assert.equal(persisted.layers.working[0].value, "Пятница");
    assert.equal(persisted.layers.longTerm[0].value, "JavaScript");
    reopenedStore.close();
  } finally {
    try {
      memoryStore.close();
    } catch {
      // Store may already be closed after the persistence check.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

function receivedMessages(request) {
  return request.messages.map(({ role, content }) => ({ role, content }));
}
