const endpoint = "https://openrouter.ai/api/v1/chat/completions";

export async function askOpenRouter({ apiKey, model, prompt, maxTokens, stop, temperature }) {
  const startedAt = performance.now();
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
  };

  if (maxTokens != null) {
    body.max_tokens = maxTokens;
  }
  if (stop) {
    body.stop = [stop];
  }
  if (temperature != null) {
    body.temperature = temperature;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "AI Advent",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (cause) {
    const error = new Error(
      cause.name === "TimeoutError"
        ? "OpenRouter не ответил за 45 секунд. Попробуй ещё раз."
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

  return {
    answer: data.choices?.[0]?.message?.content || "",
    model: data.model || model,
    usage: data.usage || null,
    cost: data.usage?.cost ?? null,
    finishReason: data.choices?.[0]?.finish_reason || null,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
