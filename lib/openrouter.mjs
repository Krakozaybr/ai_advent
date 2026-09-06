import { writeFile } from "node:fs/promises";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";

export function getModel() {
  const model = process.env.OPENROUTER_MODEL;
  if (!model) {
    throw new Error("Укажи модель: OPENROUTER_MODEL=provider/model.");
  }
  return model;
}

function getKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("Не задан OPENROUTER_API_KEY.");
  }
  return key;
}

export async function askOpenRouter({ model, prompt, ...options }) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      ...options,
    }),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return {
    answer: data.choices?.[0]?.message?.content || "",
    cost: data.usage?.cost ?? null,
    latencyMs: Math.round(performance.now() - startedAt),
    model: data.model,
    usage: data.usage,
  };
}

export async function saveResult(path, result) {
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
}
