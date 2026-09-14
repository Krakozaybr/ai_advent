import { estimateMessagesTokens } from "./token-counter.mjs";

function parseFacts(text) {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("модель не вернула JSON-объект");
  }

  const parsed = JSON.parse(withoutFence.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("facts должны быть JSON-объектом");
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .filter(([key, value]) => key.trim() && ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 30)
      .map(([key, value]) => [key.trim(), String(value)]),
  );
}

function buildFactExtractionMessages(facts, userMessage) {
  return [
    {
      role: "system",
      content:
        "Ты обновляешь Sticky Facts агента. Верни только полный JSON-объект: короткие ключи и строковые значения. Сохрани актуальные цели, ограничения, предпочтения, решения, имена, числа и сроки. Новое сообщение может изменить старый факт.",
    },
    {
      role: "user",
      content: `Текущие facts:\n${JSON.stringify(facts, null, 2)}\n\nНовое сообщение:\n${userMessage}\n\nВерни обновлённые facts.`,
    },
  ];
}

function factsMessage(facts) {
  return {
    role: "system",
    content: `Sticky Facts — считай их актуальными:\n${JSON.stringify(facts, null, 2)}`,
  };
}

export class ContextStrategyAgent {
  constructor({
    apiKey,
    facts,
    factsMaxTokens,
    history,
    keepLast,
    maxTokens,
    model,
    requestLlm,
    strategy,
    systemPrompt,
    temperature,
  }) {
    this.apiKey = apiKey;
    this.facts = facts;
    this.factsMaxTokens = factsMaxTokens;
    this.history = history;
    this.keepLast = keepLast;
    this.maxTokens = maxTokens;
    this.model = model;
    this.requestLlm = requestLlm;
    this.strategy = strategy;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async respond(userMessage) {
    let nextFacts = this.facts;
    let extractionResponse = null;
    let extractionWarning = "";

    if (this.strategy === "facts") {
      const extractionMessages = buildFactExtractionMessages(this.facts, userMessage);
      extractionResponse = await this.requestLlm({
        apiKey: this.apiKey,
        maxTokens: this.factsMaxTokens,
        messages: extractionMessages,
        model: this.model,
        temperature: 0,
      });
      try {
        nextFacts = parseFacts(extractionResponse.answer);
      } catch (error) {
        extractionWarning = `Не удалось автоматически обновить facts: ${error.message}. Используются предыдущие значения.`;
      }
    }

    const recentHistory = this.history.slice(-this.keepLast);
    const fullMessages = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
      { role: "user", content: userMessage },
    ];
    const messages = [
      { role: "system", content: this.systemPrompt },
      ...(this.strategy === "facts" && Object.keys(nextFacts).length > 0
        ? [factsMessage(nextFacts)]
        : []),
      ...(this.strategy === "branching" ? this.history : recentHistory),
      { role: "user", content: userMessage },
    ];
    const response = await this.requestLlm({
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      messages,
      model: this.model,
      temperature: this.temperature,
    });
    const estimatedFullInput = estimateMessagesTokens(fullMessages);
    const estimatedSentInput = estimateMessagesTokens(messages);

    return {
      strategy: this.strategy,
      response,
      facts: nextFacts,
      extraction: {
        response: extractionResponse,
        warning: extractionWarning,
      },
      context: {
        totalHistoryMessages: this.history.length,
        sentHistoryMessages:
          this.strategy === "branching" ? this.history.length : recentHistory.length,
        factsCount: Object.keys(nextFacts).length,
      },
      tokenCounts: {
        estimatedFullInput,
        estimatedSentInput,
        estimatedSaved: Math.max(0, estimatedFullInput - estimatedSentInput),
        actualInput: response.usage?.prompt_tokens ?? null,
        actualOutput: response.usage?.completion_tokens ?? null,
        extractionInput: extractionResponse?.usage?.prompt_tokens ?? null,
        extractionOutput: extractionResponse?.usage?.completion_tokens ?? null,
      },
    };
  }
}
