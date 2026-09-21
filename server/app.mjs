import express from "express";
import { LlmAgent } from "./agent.mjs";
import { createConversationStore } from "./conversation-store.mjs";
import { runDay3Method } from "./day3.mjs";
import { runDay4Experiment } from "./day4.mjs";
import { runDay5Experiment } from "./day5.mjs";
import { runDay8Experiment } from "./day8.mjs";
import { ContextCompressionAgent } from "./day9.mjs";
import { ContextStrategyAgent } from "./day10.mjs";
import { MemoryLayerAgent } from "./day11.mjs";
import { PersonalizedAgent } from "./day12.mjs";
import { TaskStateAgent } from "./day13.mjs";
import { InvariantAgent } from "./day14.mjs";
import { createInvariantStore } from "./invariant-store.mjs";
import { createLifecycleStore } from "./lifecycle-store.mjs";
import { createMemoryStore } from "./memory-store.mjs";
import { createMemoryMcpClient } from "./memory-mcp-client.mjs";
import { askOpenRouter } from "./openrouter.mjs";
import { createProfileStore } from "./profile-store.mjs";
import { createSettingsStore } from "./settings.mjs";
import { createTaskStore } from "./task-store.mjs";
import { DAY7_CONVERSATION_ID } from "../shared/day7.js";
import { DAY11_MEMORY_LAYERS, DAY11_SCOPE_ID } from "../shared/day11.js";
import { DAY12_DEFAULT_PROFILES, DAY12_SCOPE_ID } from "../shared/day12.js";
import { DAY13_DEFAULT_TASK, DAY13_SCOPE_ID } from "../shared/day13.js";
import {
  DAY14_DEFAULT_INVARIANTS,
  DAY14_SCOPE_ID,
} from "../shared/day14.js";
import {
  DAY15_DEFAULT_LIFECYCLE,
  DAY15_GUARDS,
  DAY15_SCOPE_ID,
  DAY15_STATES,
} from "../shared/day15.js";

function isMessageHistory(value) {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string",
    )
  );
}

function normalizeHistory(history) {
  return history.map(({ role, content }) => ({ role, content }));
}

function normalizeFacts(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value);
  if (
    entries.length > 30 ||
    entries.some(
      ([key, fact]) =>
        !key.trim() || !["string", "number", "boolean"].includes(typeof fact),
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries.map(([key, fact]) => [key.trim(), String(fact)]));
}

export function createApp({
  settingsStore = createSettingsStore(),
  conversationStore,
  memoryStore,
  memoryMcpClient,
  profileStore,
  taskStore,
  invariantStore,
  lifecycleStore,
  requestLlm = askOpenRouter,
  environmentApiKey = process.env.OPENROUTER_API_KEY || "",
} = {}) {
  const app = express();
  let resolvedConversationStore = conversationStore;
  let resolvedMemoryStore = memoryStore;
  let resolvedMemoryMcpClient = memoryMcpClient;
  let resolvedProfileStore = profileStore;
  let resolvedTaskStore = taskStore;
  let resolvedInvariantStore = invariantStore;
  let resolvedLifecycleStore = lifecycleStore;

  function getConversationStore() {
    if (!resolvedConversationStore) {
      resolvedConversationStore = createConversationStore();
    }
    return resolvedConversationStore;
  }

  function getMemoryStore() {
    if (!resolvedMemoryStore) {
      resolvedMemoryStore = createMemoryStore();
    }
    return resolvedMemoryStore;
  }

  function getMemoryMcpClient() {
    if (!resolvedMemoryMcpClient) {
      resolvedMemoryMcpClient = createMemoryMcpClient();
    }
    return resolvedMemoryMcpClient;
  }

  function getProfileStore() {
    if (!resolvedProfileStore) {
      resolvedProfileStore = createProfileStore();
    }
    return resolvedProfileStore;
  }

  function getTaskStore() {
    if (!resolvedTaskStore) {
      resolvedTaskStore = createTaskStore();
    }
    return resolvedTaskStore;
  }

  function getInvariantStore() {
    if (!resolvedInvariantStore) {
      resolvedInvariantStore = createInvariantStore();
    }
    return resolvedInvariantStore;
  }

  function getLifecycleStore() {
    if (!resolvedLifecycleStore) {
      resolvedLifecycleStore = createLifecycleStore();
    }
    return resolvedLifecycleStore;
  }

  function getDay13State() {
    const tasks = getTaskStore();
    tasks.ensure(DAY13_SCOPE_ID, DAY13_DEFAULT_TASK);
    const memory = getMemoryStore().getState(DAY13_SCOPE_ID);
    return {
      ...tasks.getState(DAY13_SCOPE_ID),
      messages: memory.messages,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
    };
  }

  async function resolveApiKey() {
    return (await settingsStore.getApiKey()) || environmentApiKey;
  }

  app.use(express.json({ limit: "4mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/settings", async (_request, response) => {
    const savedApiKey = await settingsStore.getApiKey();
    response.json({
      hasApiKey: Boolean(savedApiKey || environmentApiKey),
      source: savedApiKey ? "saved" : environmentApiKey ? "environment" : null,
    });
  });

  app.put("/api/settings", async (request, response) => {
    const apiKey = typeof request.body?.apiKey === "string" ? request.body.apiKey.trim() : "";
    if (apiKey.length < 10) {
      return response.status(400).json({ error: "Введи корректный API-ключ OpenRouter." });
    }

    await settingsStore.saveApiKey(apiKey);
    return response.json({ hasApiKey: true, source: "saved" });
  });

  app.post("/api/day1/run", async (request, response) => {
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);

    if (!prompt) {
      return response.status(400).json({ error: "Введи запрос для модели." });
    }
    if (!model) {
      return response.status(400).json({ error: "Укажи ID модели OpenRouter." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const result = await requestLlm({ apiKey, model, prompt, maxTokens });
    return response.json(result);
  });

  app.post("/api/day2/run", async (request, response) => {
    const variant = request.body?.variant;
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const stop = typeof request.body?.stop === "string" ? request.body.stop.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);

    if (variant !== "free" && variant !== "controlled") {
      return response.status(400).json({ error: "Неизвестный вариант эксперимента." });
    }
    if (!prompt || !model) {
      return response.status(400).json({ error: "Заполни prompt и модель." });
    }
    if (variant === "controlled") {
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
        return response.status(400).json({
          error: "maxTokens должен быть целым числом от 1 до 8192.",
        });
      }
      if (!stop || stop.length > 50) {
        return response.status(400).json({
          error: "Stop sequence должна содержать от 1 до 50 символов.",
        });
      }
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const llmRequest = { apiKey, model, prompt };
    if (variant === "controlled") {
      llmRequest.maxTokens = maxTokens;
      llmRequest.stop = stop;
    }
    const result = await requestLlm(llmRequest);
    const countWords = (text) => (text.trim() ? text.trim().split(/\s+/u).length : 0);

    return response.json({
      variant,
      request: {
        prompt,
        model,
        ...(variant === "controlled" ? { maxTokens, stop } : {}),
      },
      response: { ...result, wordCount: countWords(result.answer) },
    });
  });

  app.post("/api/day3/run", async (request, response) => {
    const method = request.body?.method;
    const task = typeof request.body?.task === "string" ? request.body.task.trim() : "";
    const instruction =
      typeof request.body?.instruction === "string" ? request.body.instruction.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const allowedMethods = ["direct", "step", "meta", "experts"];

    if (!allowedMethods.includes(method)) {
      return response.status(400).json({ error: "Неизвестный способ рассуждения." });
    }
    if (!task || !instruction || !model) {
      return response.status(400).json({ error: "Заполни задачу, инструкцию и модель." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const result = await runDay3Method({
      apiKey,
      instruction,
      maxTokens,
      method,
      model,
      requestLlm,
      task,
    });
    return response.json(result);
  });

  app.post("/api/day4/run", async (request, response) => {
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!prompt || !model) {
      return response.status(400).json({ error: "Заполни prompt и модель." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const result = await runDay4Experiment({
      apiKey,
      maxTokens,
      model,
      prompt,
      requestLlm,
      temperature,
    });
    return response.json(result);
  });

  app.post("/api/day5/run", async (request, response) => {
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!prompt || !model) {
      return response.status(400).json({ error: "Заполни prompt и модель." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const result = await runDay5Experiment({
      apiKey,
      maxTokens,
      model,
      prompt,
      requestLlm,
      temperature,
    });
    return response.json(result);
  });

  app.post("/api/day6/chat", async (request, response) => {
    const agentName =
      typeof request.body?.agentName === "string" ? request.body.agentName.trim() : "";
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!agentName || !systemPrompt || !message || !model) {
      return response.status(400).json({
        error: "Заполни имя агента, системную инструкцию, сообщение и модель.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const agent = new LlmAgent({
      apiKey,
      maxTokens,
      model,
      requestLlm,
      systemPrompt,
      temperature,
    });
    const agentResponse = await agent.respond(message);

    return response.json({
      agent: { name: agentName, type: "LlmAgent" },
      input: message,
      response: agentResponse,
    });
  });

  app.get("/api/day7/history", (_request, response) => {
    const messages = getConversationStore().listMessages(DAY7_CONVERSATION_ID);
    response.json({
      conversationId: DAY7_CONVERSATION_ID,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
      messages,
    });
  });

  app.delete("/api/day7/history", (_request, response) => {
    const store = getConversationStore();
    store.clear(DAY7_CONVERSATION_ID);
    response.json({
      conversationId: DAY7_CONVERSATION_ID,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
      messages: [],
    });
  });

  app.post("/api/day7/chat", async (request, response) => {
    const agentName =
      typeof request.body?.agentName === "string" ? request.body.agentName.trim() : "";
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!agentName || !systemPrompt || !message || !model) {
      return response.status(400).json({
        error: "Заполни имя агента, системную инструкцию, сообщение и модель.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const store = getConversationStore();
    const history = store.listMessages(DAY7_CONVERSATION_ID).map(({ role, content }) => ({
      role,
      content,
    }));
    const agent = new LlmAgent({
      apiKey,
      history,
      maxTokens,
      model,
      requestLlm,
      systemPrompt,
      temperature,
    });
    const agentResponse = await agent.respond(message);

    store.appendExchange(DAY7_CONVERSATION_ID, message, agentResponse.answer);

    return response.json({
      agent: { name: agentName, type: "LlmAgent" },
      conversationId: DAY7_CONVERSATION_ID,
      input: message,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
      response: agentResponse,
      history: store.listMessages(DAY7_CONVERSATION_ID),
    });
  });

  app.post("/api/day8/run", async (request, response) => {
    const scenario = request.body?.scenario;
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const contextLimit = Number(request.body?.contextLimit);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);
    const rawHistory = request.body?.history;

    if (!Object.hasOwn({ short: true, long: true, overflow: true }, scenario)) {
      return response.status(400).json({ error: "Неизвестный сценарий Дня 8." });
    }
    if (!systemPrompt || !prompt || !model) {
      return response.status(400).json({
        error: "Заполни системную инструкцию, текущий запрос и модель.",
      });
    }
    if (
      !Array.isArray(rawHistory) ||
      rawHistory.length > 200 ||
      rawHistory.some(
        (message) =>
          !message ||
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string",
      )
    ) {
      return response.status(400).json({
        error: "История должна содержать не более 200 сообщений user/assistant.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (!Number.isInteger(contextLimit) || contextLimit < 256 || contextLimit > 1_000_000) {
      return response.status(400).json({
        error: "Учебный лимит контекста должен быть целым числом от 256 до 1000000.",
      });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const result = await runDay8Experiment({
      apiKey,
      contextLimit,
      history: rawHistory.map(({ role, content }) => ({ role, content })),
      maxTokens,
      model,
      prompt,
      requestLlm,
      scenario,
      systemPrompt,
      temperature,
    });
    return response.json(result);
  });

  app.post("/api/day9/compare", async (request, response) => {
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const summary = typeof request.body?.summary === "string" ? request.body.summary.trim() : "";
    const fullHistory = request.body?.fullHistory;
    const compressedHistory = request.body?.compressedHistory;
    const maxTokens = Number(request.body?.maxTokens);
    const summaryMaxTokens = Number(request.body?.summaryMaxTokens);
    const keepLast = Number(request.body?.keepLast);
    const summarizedMessageCount = Number(request.body?.summarizedMessageCount);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!systemPrompt || !message || !model) {
      return response.status(400).json({
        error: "Заполни системную инструкцию, сообщение и модель.",
      });
    }
    if (!isMessageHistory(fullHistory) || !isMessageHistory(compressedHistory)) {
      return response.status(400).json({
        error: "Каждая история должна содержать не более 200 сообщений user/assistant.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (!Number.isInteger(summaryMaxTokens) || summaryMaxTokens < 1 || summaryMaxTokens > 2048) {
      return response.status(400).json({
        error: "Лимит summary должен быть целым числом от 1 до 2048.",
      });
    }
    if (!Number.isInteger(keepLast) || keepLast < 1 || keepLast > 40) {
      return response.status(400).json({ error: "N должен быть целым числом от 1 до 40." });
    }
    if (
      !Number.isInteger(summarizedMessageCount) ||
      summarizedMessageCount < 0 ||
      summarizedMessageCount > compressedHistory.length
    ) {
      return response.status(400).json({ error: "Некорректная позиция summary в истории." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const agent = new ContextCompressionAgent({
      apiKey,
      fullHistory: normalizeHistory(fullHistory),
      compressedHistory: normalizeHistory(compressedHistory),
      keepLast,
      maxTokens,
      model,
      requestLlm,
      summarizedMessageCount,
      summary,
      summaryMaxTokens,
      systemPrompt,
      temperature,
    });
    const result = await agent.compare(message);

    return response.json({
      agent: { name: "ContextCompressionAgent", type: "agent" },
      input: message,
      ...result,
    });
  });

  app.post("/api/day10/chat", async (request, response) => {
    const strategy = request.body?.strategy;
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const branchId =
      typeof request.body?.branchId === "string" ? request.body.branchId.trim() : "main";
    const history = request.body?.history;
    const facts = normalizeFacts(request.body?.facts);
    const maxTokens = Number(request.body?.maxTokens);
    const factsMaxTokens = Number(request.body?.factsMaxTokens);
    const keepLast = Number(request.body?.keepLast);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!Object.hasOwn({ sliding: true, facts: true, branching: true }, strategy)) {
      return response.status(400).json({ error: "Неизвестная стратегия Дня 10." });
    }
    if (!systemPrompt || !message || !model || !branchId) {
      return response.status(400).json({
        error: "Заполни системную инструкцию, сообщение, модель и ветку.",
      });
    }
    if (!isMessageHistory(history)) {
      return response.status(400).json({
        error: "История должна содержать не более 200 сообщений user/assistant.",
      });
    }
    if (facts == null) {
      return response.status(400).json({
        error: "Facts должны быть JSON-объектом максимум из 30 простых значений.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (!Number.isInteger(factsMaxTokens) || factsMaxTokens < 1 || factsMaxTokens > 2048) {
      return response.status(400).json({
        error: "Лимит facts должен быть целым числом от 1 до 2048.",
      });
    }
    if (!Number.isInteger(keepLast) || keepLast < 1 || keepLast > 40) {
      return response.status(400).json({ error: "N должен быть целым числом от 1 до 40." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const agent = new ContextStrategyAgent({
      apiKey,
      facts,
      factsMaxTokens,
      history: normalizeHistory(history),
      keepLast,
      maxTokens,
      model,
      requestLlm,
      strategy,
      systemPrompt,
      temperature,
    });
    const result = await agent.respond(message);

    return response.json({
      agent: { name: "ContextStrategyAgent", type: "agent" },
      branchId,
      input: message,
      ...result,
    });
  });

  app.get("/api/day11/state", (_request, response) => {
    response.json({
      scopeId: DAY11_SCOPE_ID,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
      mcp: {
        server: "ai-advent-memory",
        transport: "stdio",
        tools: ["memory_list", "memory_save", "memory_delete"],
      },
      ...getMemoryStore().getState(DAY11_SCOPE_ID),
    });
  });

  app.post("/api/day11/memory", (request, response) => {
    const layer = request.body?.layer;
    const key = typeof request.body?.key === "string" ? request.body.key.trim() : "";
    const value = typeof request.body?.value === "string" ? request.body.value.trim() : "";

    if (!Object.hasOwn(DAY11_MEMORY_LAYERS, layer)) {
      return response.status(400).json({ error: "Выбери существующий слой памяти." });
    }
    if (!key || key.length > 80 || !value || value.length > 2_000) {
      return response.status(400).json({
        error: "Ключ должен содержать до 80 символов, значение — до 2000 символов.",
      });
    }

    getMemoryStore().upsertItem(DAY11_SCOPE_ID, layer, key, value);
    return response.json(getMemoryStore().getState(DAY11_SCOPE_ID));
  });

  app.delete("/api/day11/memory/:layer/:key", (request, response) => {
    const { layer, key } = request.params;
    if (!Object.hasOwn(DAY11_MEMORY_LAYERS, layer)) {
      return response.status(400).json({ error: "Выбери существующий слой памяти." });
    }
    getMemoryStore().deleteItem(DAY11_SCOPE_ID, layer, key);
    return response.json(getMemoryStore().getState(DAY11_SCOPE_ID));
  });

  app.delete("/api/day11/memory/:layer", (request, response) => {
    const { layer } = request.params;
    if (!Object.hasOwn(DAY11_MEMORY_LAYERS, layer)) {
      return response.status(400).json({ error: "Выбери существующий слой памяти." });
    }
    getMemoryStore().clearLayer(DAY11_SCOPE_ID, layer);
    return response.json(getMemoryStore().getState(DAY11_SCOPE_ID));
  });

  app.delete("/api/day11/state", (_request, response) => {
    getMemoryStore().clear(DAY11_SCOPE_ID);
    return response.json(getMemoryStore().getState(DAY11_SCOPE_ID));
  });

  app.post("/api/day11/compare", async (request, response) => {
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!systemPrompt || !message || !model) {
      return response.status(400).json({
        error: "Заполни системную инструкцию, сообщение и модель.",
      });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const store = getMemoryStore();
    const agent = new MemoryLayerAgent({
      apiKey,
      maxTokens,
      memoryState: store.getState(DAY11_SCOPE_ID),
      memoryTools: getMemoryMcpClient(),
      model,
      requestLlm,
      systemPrompt,
      temperature,
    });
    const result = await agent.compare(message);
    store.appendExchange(DAY11_SCOPE_ID, message, result.responses.withMemory.answer);

    return response.json({
      agent: { name: "MemoryLayerAgent", type: "agent" },
      input: message,
      state: store.getState(DAY11_SCOPE_ID),
      ...result,
    });
  });

  app.get("/api/day12/state", (_request, response) => {
    const profiles = getProfileStore().ensureDefaults(DAY12_SCOPE_ID, DAY12_DEFAULT_PROFILES);
    const memory = getMemoryStore().getState(DAY11_SCOPE_ID);
    response.json({
      profiles,
      memory: {
        messages: memory.messages.length,
        items: Object.values(memory.layers).reduce((sum, items) => sum + items.length, 0),
      },
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
    });
  });

  app.put("/api/day12/profiles/:id", (request, response) => {
    const fields = ["name", "expertise", "style", "format", "constraints", "language"];
    const profile = Object.fromEntries(
      fields.map((field) => [
        field,
        typeof request.body?.[field] === "string" ? request.body[field].trim() : "",
      ]),
    );
    if (fields.some((field) => !profile[field] || profile[field].length > 1_000)) {
      return response.status(400).json({
        error: "Заполни все поля профиля; каждое поле должно быть короче 1000 символов.",
      });
    }

    getProfileStore().ensureDefaults(DAY12_SCOPE_ID, DAY12_DEFAULT_PROFILES);
    const updated = getProfileStore().update(DAY12_SCOPE_ID, request.params.id, profile);
    if (!updated) {
      return response.status(404).json({ error: "Профиль не найден." });
    }
    return response.json(updated);
  });

  app.post("/api/day12/compare", async (request, response) => {
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const profileIds = request.body?.profileIds;
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);

    if (!systemPrompt || !message || !model) {
      return response.status(400).json({ error: "Заполни инструкцию, сообщение и модель." });
    }
    if (
      !Array.isArray(profileIds) ||
      profileIds.length !== 2 ||
      profileIds.some((id) => typeof id !== "string")
    ) {
      return response.status(400).json({ error: "Для сравнения нужны два профиля." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }
    const profilesStore = getProfileStore();
    profilesStore.ensureDefaults(DAY12_SCOPE_ID, DAY12_DEFAULT_PROFILES);
    const profiles = profileIds.map((id) => profilesStore.get(DAY12_SCOPE_ID, id));
    if (profiles.some((profile) => !profile)) {
      return response.status(404).json({ error: "Один из профилей не найден." });
    }

    const agent = new PersonalizedAgent({
      apiKey,
      maxTokens,
      memoryState: getMemoryStore().getState(DAY11_SCOPE_ID),
      model,
      requestLlm,
      systemPrompt,
      temperature,
    });
    const result = await agent.compare(message, profiles);
    return response.json({
      agent: { name: "PersonalizedAgent", type: "agent" },
      input: message,
      ...result,
    });
  });

  app.get("/api/day13/state", (_request, response) => {
    response.json(getDay13State());
  });

  app.put("/api/day13/task", (request, response) => {
    const title = typeof request.body?.title === "string" ? request.body.title.trim() : "";
    const currentStep =
      typeof request.body?.currentStep === "string" ? request.body.currentStep.trim() : "";
    const expectedAction =
      typeof request.body?.expectedAction === "string" ? request.body.expectedAction.trim() : "";
    if (
      !title ||
      !currentStep ||
      !expectedAction ||
      [title, currentStep, expectedAction].some((value) => value.length > 1_000)
    ) {
      return response.status(400).json({ error: "Заполни название, текущий шаг и ожидаемое действие." });
    }
    getTaskStore().ensure(DAY13_SCOPE_ID, DAY13_DEFAULT_TASK);
    getTaskStore().update(DAY13_SCOPE_ID, { title, currentStep, expectedAction });
    return response.json(getDay13State());
  });

  app.post("/api/day13/action", (request, response) => {
    const action = request.body?.action;
    const tasks = getTaskStore();
    tasks.ensure(DAY13_SCOPE_ID, DAY13_DEFAULT_TASK);
    let result;
    if (action === "advance") result = tasks.advance(DAY13_SCOPE_ID);
    else if (action === "pause") result = tasks.setPaused(DAY13_SCOPE_ID, true);
    else if (action === "resume") result = tasks.setPaused(DAY13_SCOPE_ID, false);
    else if (action === "reset") {
      getMemoryStore().clear(DAY13_SCOPE_ID);
      result = { ok: true, ...tasks.reset(DAY13_SCOPE_ID, DAY13_DEFAULT_TASK) };
    } else {
      return response.status(400).json({ error: "Неизвестное действие с задачей." });
    }
    return response.status(result.ok ? 200 : 409).json({ ...result, ...getDay13State() });
  });

  app.post("/api/day13/chat", async (request, response) => {
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);
    if (!systemPrompt || !message || !model) {
      return response.status(400).json({ error: "Заполни инструкцию, сообщение и модель." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }
    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const tasks = getTaskStore();
    const task = tasks.ensure(DAY13_SCOPE_ID, DAY13_DEFAULT_TASK);
    const memory = getMemoryStore();
    const history = memory.getState(DAY13_SCOPE_ID).messages;
    const agent = new TaskStateAgent({
      apiKey,
      history,
      maxTokens,
      model,
      requestLlm,
      systemPrompt,
      task,
      temperature,
    });
    const agentResponse = await agent.respond(message);
    memory.appendExchange(DAY13_SCOPE_ID, message, agentResponse.answer);
    return response.json({
      agent: { name: "TaskStateAgent", type: "agent" },
      input: message,
      response: agentResponse,
      state: getDay13State(),
    });
  });

  app.get("/api/day14/state", (_request, response) => {
    const invariants = getInvariantStore().ensureDefaults(
      DAY14_SCOPE_ID,
      DAY14_DEFAULT_INVARIANTS,
    );
    response.json({
      invariants,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
    });
  });

  app.post("/api/day14/invariants", (request, response) => {
    const category =
      typeof request.body?.category === "string" ? request.body.category.trim() : "";
    const rule = typeof request.body?.rule === "string" ? request.body.rule.trim() : "";
    const forbiddenTerms = Array.isArray(request.body?.forbiddenTerms)
      ? request.body.forbiddenTerms
          .filter((term) => typeof term === "string")
          .map((term) => term.trim())
          .filter(Boolean)
      : [];
    if (
      !category ||
      !rule ||
      forbiddenTerms.length === 0 ||
      forbiddenTerms.length > 20 ||
      category.length > 80 ||
      rule.length > 1_000 ||
      forbiddenTerms.some((term) => term.length > 80)
    ) {
      return response.status(400).json({
        error: "Заполни категорию, правило и от 1 до 20 запрещённых терминов.",
      });
    }
    const store = getInvariantStore();
    store.ensureDefaults(DAY14_SCOPE_ID, DAY14_DEFAULT_INVARIANTS);
    return response.json({
      invariants: store.add(DAY14_SCOPE_ID, { category, rule, forbiddenTerms }),
    });
  });

  app.delete("/api/day14/invariants/:id", (request, response) => {
    const store = getInvariantStore();
    store.ensureDefaults(DAY14_SCOPE_ID, DAY14_DEFAULT_INVARIANTS);
    return response.json({
      invariants: store.delete(DAY14_SCOPE_ID, request.params.id),
    });
  });

  app.post("/api/day14/chat", async (request, response) => {
    const systemPrompt =
      typeof request.body?.systemPrompt === "string" ? request.body.systemPrompt.trim() : "";
    const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const maxTokens = Number(request.body?.maxTokens);
    const rawTemperature = request.body?.temperature;
    const temperature = Number(rawTemperature);
    if (!systemPrompt || !message || !model) {
      return response.status(400).json({ error: "Заполни инструкцию, сообщение и модель." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (
      rawTemperature == null ||
      rawTemperature === "" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2
    ) {
      return response.status(400).json({ error: "temperature должна быть числом от 0 до 2." });
    }

    const store = getInvariantStore();
    const invariants = store.ensureDefaults(DAY14_SCOPE_ID, DAY14_DEFAULT_INVARIANTS);
    const options = {
      apiKey: "",
      invariants,
      maxTokens,
      model,
      requestLlm,
      systemPrompt,
      temperature,
    };
    const policyAgent = new InvariantAgent(options);
    const conflicts = policyAgent.check(message);
    if (conflicts.length > 0) {
      const result = await policyAgent.respond(message);
      return response.json({
        agent: { name: "InvariantAgent", type: "agent" },
        input: message,
        ...result,
      });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }
    const result = await new InvariantAgent({ ...options, apiKey }).respond(message);
    return response.json({
      agent: { name: "InvariantAgent", type: "agent" },
      input: message,
      ...result,
    });
  });

  app.get("/api/day15/state", (_request, response) => {
    const state = getLifecycleStore().ensure(DAY15_SCOPE_ID, DAY15_DEFAULT_LIFECYCLE);
    response.json({
      ...state,
      persistence: { type: "SQLite", file: "data/agent.sqlite" },
    });
  });

  app.patch("/api/day15/guards/:guard", (request, response) => {
    const guard = request.params.guard;
    const value = request.body?.value;
    if (!Object.hasOwn(DAY15_GUARDS, guard) || typeof value !== "boolean") {
      return response.status(400).json({ error: "Укажи существующее условие и boolean-значение." });
    }
    const store = getLifecycleStore();
    store.ensure(DAY15_SCOPE_ID, DAY15_DEFAULT_LIFECYCLE);
    return response.json(store.setGuard(DAY15_SCOPE_ID, guard, value));
  });

  app.post("/api/day15/action", (request, response) => {
    const action = request.body?.action;
    const store = getLifecycleStore();
    store.ensure(DAY15_SCOPE_ID, DAY15_DEFAULT_LIFECYCLE);
    if (action === "transition") {
      const target = request.body?.target;
      if (!DAY15_STATES.includes(target)) {
        return response.status(400).json({ error: "Выбери существующее состояние." });
      }
      return response.json(store.transition(DAY15_SCOPE_ID, target));
    }
    if (action === "pause") return response.json(store.setPaused(DAY15_SCOPE_ID, true));
    if (action === "resume") return response.json(store.setPaused(DAY15_SCOPE_ID, false));
    if (action === "reset") {
      return response.json(store.reset(DAY15_SCOPE_ID, DAY15_DEFAULT_LIFECYCLE));
    }
    return response.status(400).json({ error: "Неизвестное действие с жизненным циклом." });
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(error.statusCode || error.status || 500).json({
      error: error.message || "Не удалось выполнить запрос.",
    });
  });

  return app;
}
