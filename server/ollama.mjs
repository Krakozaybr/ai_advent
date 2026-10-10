export const localAnswerModel = "qwen3:4b";
export const localEmbeddingModel = "ollama/qwen3-embedding:0.6b";

function modelName(value) {
  const name = value.replace(/^ollama\//u, "");
  if (!/^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/u.test(name) || /(?:^|[-:])cloud(?:$|[-:])/iu.test(name)) throw new Error("Нужна локальная модель, без суффикса cloud.");
  return name;
}

export function createOllamaClient({ baseUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", model = process.env.OLLAMA_MODEL ?? localAnswerModel, temperature = 0, contextWindow = 8192, maxTokens = 4096, jsonMaxTokens = 800, onMetrics = () => {} } = {}, fetchImpl = fetch) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Ollama должен использовать локальный HTTP-адрес без пути и авторизации.");
  modelName(model);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || ![contextWindow, maxTokens, jsonMaxTokens].every(Number.isInteger) || contextWindow < 1024 || contextWindow > 32768 || maxTokens < 1 || jsonMaxTokens < 1 || maxTokens >= contextWindow || jsonMaxTokens >= contextWindow) throw new Error("Некорректные параметры локальной модели.");
  async function request(path, body) {
    const started = performance.now();
    let response;
    try {
      response = await fetchImpl(new URL(path, url), { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new Error(`Ollama недоступен на ${url.origin}. Запусти npm run local:serve. ${error.message}`);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 404 && body?.model ? `Модель ${body.model} не установлена. Выполни npm run local:pull.` : `Ollama HTTP ${response.status}: ${result.error ?? "ошибка запроса"}`);
    if (body) onMetrics({ operation: path === "/api/embed" ? "embedding" : "generation", model: body.model, elapsedMs: Math.round(performance.now() - started), totalMs: Math.round((result.total_duration ?? 0) / 1e6), loadMs: Math.round((result.load_duration ?? 0) / 1e6), inputTokens: result.prompt_eval_count ?? 0, outputTokens: result.eval_count ?? 0, tokensPerSecond: result.eval_duration ? Math.round((result.eval_count ?? 0) / result.eval_duration * 1e9 * 10) / 10 : null });
    return result;
  }
  return {
    baseUrl: url.origin,
    model,
    settings: { temperature, contextWindow, maxTokens, jsonMaxTokens },
    async inspect() { return request("/api/show", { model: modelName(model) }); },
    async running() { return request("/api/ps"); },
    async status() {
      const [version, tags] = await Promise.all([request("/api/version"), request("/api/tags")]);
      return { endpoint: url.origin, version: version.version, model, models: (tags.models ?? []).map(({ name, size }) => ({ name, size })), localOnly: true };
    },
    async embed(texts, embedding = localEmbeddingModel) {
      if (!texts.length) return [];
      const result = await request("/api/embed", { model: modelName(embedding), input: texts, truncate: false, keep_alive: "10m" });
      if (!Array.isArray(result.embeddings) || result.embeddings.length !== texts.length || result.embeddings.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((n) => !Number.isFinite(n)))) throw new Error("Ollama вернул неполные или неверные эмбеддинги.");
      return result.embeddings;
    },
    async complete(messages, requestedModel = model) {
      const jsonMode = messages.some((message) => message.role === "system" && message.content.includes("Верни строгий JSON"));
      const localModel = modelName(requestedModel);
      const input = messages.map((message, index) => /^qwen3:/u.test(localModel) && index === messages.length - 1 && message.role === "user" ? { ...message, content: `${message.content}\n/no_think` } : message);
      const outputBudget = jsonMode ? jsonMaxTokens : maxTokens;
      const result = await request("/api/chat", { model: localModel, messages: input, stream: false, think: false, ...(jsonMode ? { format: "json" } : {}), options: { temperature, num_ctx: contextWindow, num_predict: outputBudget }, keep_alive: "10m" });
      if (result.done_reason === "length") throw new Error(`Локальная модель не завершила ответ: исчерпан лимит ${outputBudget} токенов. Попробуй более короткий запрос.`);
      if (result.done !== true || !result.message?.content?.trim()) throw new Error("Локальная модель не завершила ответ или вернула пустой текст.");
      // Некоторые шаблоны Qwen возвращают закрывающий тег без открывающего.
      // Всё до него относится к рассуждению, а не к публичному ответу.
      const content = result.message.content;
      const publicAnswer = (content.includes("</think>") ? content.slice(content.lastIndexOf("</think>") + "</think>".length) : content).trim();
      if (!publicAnswer || publicAnswer.includes("<think>")) throw new Error("Локальная модель не вернула публичный ответ.");
      return publicAnswer;
    },
  };
}
