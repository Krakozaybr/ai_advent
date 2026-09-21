const endpoint = "https://openrouter.ai/api/v1/chat/completions";

export function buildOpenRouterRequest({
  messages,
  model,
  plugins,
  prompt,
  maxTokens,
  stop,
  temperature,
  tools,
  toolChoice,
  parallelToolCalls,
}) {
  const json = {
    model,
    messages: messages || [{ role: "user", content: prompt }],
  };

  if (maxTokens != null) {
    json.max_tokens = maxTokens;
  }
  if (stop) {
    json.stop = [stop];
  }
  if (temperature != null) {
    json.temperature = temperature;
  }
  if (plugins?.length) {
    json.plugins = plugins;
  }
  if (tools?.length) {
    json.tools = tools;
  }
  if (toolChoice != null) {
    json.tool_choice = toolChoice;
  }
  if (parallelToolCalls != null) {
    json.parallel_tool_calls = parallelToolCalls;
  }

  return {
    method: "POST",
    url: endpoint,
    query: {},
    json,
  };
}

export async function askOpenRouter({
  apiKey,
  messages,
  model,
  prompt,
  maxTokens,
  stop,
  temperature,
  plugins,
  tools,
  toolChoice,
  parallelToolCalls,
  timeoutMs = 45_000,
}) {
  const startedAt = performance.now();
  const httpRequest = buildOpenRouterRequest({
    messages,
    model,
    prompt,
    maxTokens,
    plugins,
    tools,
    toolChoice,
    parallelToolCalls,
    stop,
    temperature,
  });

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "AI Advent",
      },
      body: JSON.stringify(httpRequest.json),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error(
      cause.name === "TimeoutError"
        ? `OpenRouter не ответил за ${Math.round(timeoutMs / 1_000)} секунд. Попробуй ещё раз.`
        : `Не удалось обратиться к OpenRouter: ${cause.message}`,
    );
    error.statusCode = cause.name === "TimeoutError" ? 504 : 502;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `OpenRouter вернул HTTP ${response.status}.`);
    error.statusCode = 502;
    throw error;
  }

  const message = data.choices?.[0]?.message || {};
  const result = {
    answer: message.content || "",
    model: data.model || model,
    usage: data.usage || null,
    cost: data.usage?.cost ?? null,
    finishReason: data.choices?.[0]?.finish_reason || null,
    httpRequest,
    latencyMs: Math.round(performance.now() - startedAt),
  };
  if (message.tool_calls?.length) {
    result.toolCalls = message.tool_calls;
  }
  return result;
}
