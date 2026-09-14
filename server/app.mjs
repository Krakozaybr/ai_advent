import express from "express";
import { LlmAgent } from "./agent.mjs";
import { createConversationStore } from "./conversation-store.mjs";
import { runDay3Method } from "./day3.mjs";
import { runDay4Experiment } from "./day4.mjs";
import { runDay5Experiment } from "./day5.mjs";
import { runDay8Experiment } from "./day8.mjs";
import { ContextCompressionAgent } from "./day9.mjs";
import { askOpenRouter } from "./openrouter.mjs";
import { createSettingsStore } from "./settings.mjs";
import { DAY7_CONVERSATION_ID } from "../shared/day7.js";

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

export function createApp({
  settingsStore = createSettingsStore(),
  conversationStore,
  requestLlm = askOpenRouter,
  environmentApiKey = process.env.OPENROUTER_API_KEY || "",
} = {}) {
  const app = express();
  let resolvedConversationStore = conversationStore;

  function getConversationStore() {
    if (!resolvedConversationStore) {
      resolvedConversationStore = createConversationStore();
    }
    return resolvedConversationStore;
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

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(error.statusCode || error.status || 500).json({
      error: error.message || "Не удалось выполнить запрос.",
    });
  });

  return app;
}
