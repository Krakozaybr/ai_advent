const endpoint = "https://openrouter.ai/api/v1/chat/completions";

export async function askOpenRouter({ apiKey, model, prompt, maxTokens }) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "AI Advent",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
  });

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
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
