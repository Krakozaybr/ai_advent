import { buildDay8History } from "../shared/day8.js";
import { estimateMessagesTokens, estimateTextTokens } from "./token-counter.mjs";

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

  if (estimatedWithResponse > contextLimit) {
    return {
      scenario,
      blocked: true,
      reason: `Запрос заблокирован до OpenRouter: оценка входа (${estimatedInput}) + резерв ответа (${maxTokens}) превышает учебный лимит (${contextLimit}).`,
      tokenCounts,
      historyMessages: history.length,
      cost: 0,
    };
  }

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
    blocked: false,
    tokenCounts: {
      ...tokenCounts,
      actualInput: result.usage?.prompt_tokens ?? null,
      actualResponse: result.usage?.completion_tokens ?? null,
      actualTotal: result.usage?.total_tokens ?? null,
    },
    historyMessages: history.length,
  };
}
