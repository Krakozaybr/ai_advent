import { buildOpenRouterRequest } from "./openrouter.mjs";
import { estimateMessagesTokens, estimateTextTokens } from "./token-counter.mjs";

function compactRequestDetails(request) {
  const compressionEnabled = request.json.plugins?.some(
    (plugin) => plugin.id === "context-compression",
  );
  return {
    ...request,
    note: compressionEnabled
      ? "Полный текст отправлен в OpenRouter. Плагин context-compression может удалить часть середины перед вызовом модели. Здесь сообщения сокращены только для отображения."
      : "Полный текст сообщений отправлен в OpenRouter. Здесь он сокращён, чтобы не завис интерфейс.",
    json: {
      ...request.json,
      messages: request.json.messages.map((message) => ({
        role: message.role,
        content:
          message.content.length > 500
            ? `[сокращено для показа: ${message.content.length.toLocaleString("ru-RU")} символов]`
            : message.content,
      })),
    },
  };
}

export async function runDay8Experiment({
  apiKey,
  contextLimit,
  history,
  maxTokens,
  model,
  prompt,
  requestLlm,
  scenario,
  systemPrompt,
  temperature,
}) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: prompt },
  ];
  const estimatedCurrentMessage = estimateTextTokens(prompt);
  const estimatedHistory = history.length ? estimateMessagesTokens(history) : 0;
  const estimatedInput = estimateMessagesTokens(messages);
  const estimatedWithResponse = estimatedInput + maxTokens;
  const tokenCounts = {
    estimatedCurrentMessage,
    estimatedHistory,
    estimatedInput,
    reservedResponse: maxTokens,
    estimatedWithResponse,
    contextLimit,
  };

  const exceedsLimit = estimatedWithResponse > contextLimit;
  const plugins = scenario === "overflow" ? [{ id: "context-compression" }] : undefined;
  const request = buildOpenRouterRequest({ messages, model, plugins, maxTokens, temperature });

  try {
    const result = await requestLlm({
      apiKey,
      maxTokens,
      messages,
      model,
      plugins,
      temperature,
      timeoutMs: scenario === "overflow" ? 120_000 : undefined,
    });

    return {
      ...result,
      scenario,
      sent: true,
      compressionEnabled: Boolean(plugins),
      failed: false,
      exceedsLimit,
      tokenCounts: {
        ...tokenCounts,
        actualInput: result.usage?.prompt_tokens ?? null,
        actualResponse: result.usage?.completion_tokens ?? null,
        actualTotal: result.usage?.total_tokens ?? null,
      },
      historyMessages: history.length,
      httpRequest: scenario === "overflow" ? compactRequestDetails(request) : result.httpRequest,
    };
  } catch (error) {
    return {
      scenario,
      sent: true,
      compressionEnabled: Boolean(plugins),
      failed: true,
      exceedsLimit,
      reason: error.message,
      tokenCounts,
      historyMessages: history.length,
      cost: null,
      httpRequest: compactRequestDetails(request),
    };
  }
}
