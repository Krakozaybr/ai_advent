import { buildDay8History } from "../shared/day8.js";
import { buildOpenRouterRequest } from "./openrouter.mjs";
import { estimateMessagesTokens, estimateTextTokens } from "./token-counter.mjs";

function compactRequestDetails(request) {
  return {
    ...request,
    note: "Полный текст сообщений отправлен в OpenRouter. Здесь он сокращён, чтобы не завис интерфейс.",
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
  maxTokens,
  model,
  prompt,
  requestLlm,
  scenario,
  systemPrompt,
  temperature,
}) {
  const history = buildDay8History(scenario);
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: prompt },
  ];
  const estimatedCurrentMessage = estimateTextTokens(prompt);
  const estimatedHistory = estimateMessagesTokens(history);
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
  const request = buildOpenRouterRequest({ messages, model, maxTokens, temperature });

  try {
    const result = await requestLlm({
      apiKey,
      maxTokens,
      messages,
      model,
      temperature,
    });

    return {
      ...result,
      scenario,
      sent: true,
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
