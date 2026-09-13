import express from "express";
import { askOpenRouter } from "./openrouter.mjs";
import { createSettingsStore } from "./settings.mjs";

export function createApp({
  settingsStore = createSettingsStore(),
  requestLlm = askOpenRouter,
  environmentApiKey = process.env.OPENROUTER_API_KEY || "",
} = {}) {
  const app = express();

  async function resolveApiKey() {
    return (await settingsStore.getApiKey()) || environmentApiKey;
  }

  app.use(express.json({ limit: "32kb" }));

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
    const prompt = typeof request.body?.prompt === "string" ? request.body.prompt.trim() : "";
    const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
    const format = typeof request.body?.format === "string" ? request.body.format.trim() : "";
    const stop = typeof request.body?.stop === "string" ? request.body.stop.trim() : "";
    const maxWords = Number(request.body?.maxWords);
    const maxTokens = Number(request.body?.maxTokens);

    if (!prompt || !model || !format || !stop) {
      return response.status(400).json({ error: "Заполни запрос и все параметры управления." });
    }
    if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 500) {
      return response.status(400).json({ error: "maxWords должен быть целым числом от 1 до 500." });
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
      return response.status(400).json({ error: "maxTokens должен быть целым числом от 1 до 8192." });
    }
    if (stop.length > 50) {
      return response.status(400).json({ error: "Stop sequence должна быть короче 50 символов." });
    }

    const apiKey = await resolveApiKey();
    if (!apiKey) {
      return response.status(401).json({ error: "Сначала добавь API-ключ OpenRouter в настройках." });
    }

    const controlledPrompt = `${prompt}

Требования к ответу:
- ${format}
- Не более ${maxWords} слов.
- В конце отдельной строкой напиши: ${stop}`;

    const [withoutConstraints, withConstraints] = await Promise.all([
      requestLlm({ apiKey, model, prompt }),
      requestLlm({ apiKey, model, prompt: controlledPrompt, maxTokens, stop }),
    ]);
    const countWords = (text) => (text.trim() ? text.trim().split(/\s+/u).length : 0);

    return response.json({
      request: { prompt, model, format, maxWords, maxTokens, stop, controlledPrompt },
      withoutConstraints: {
        ...withoutConstraints,
        wordCount: countWords(withoutConstraints.answer),
      },
      withConstraints: {
        ...withConstraints,
        wordCount: countWords(withConstraints.answer),
      },
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
