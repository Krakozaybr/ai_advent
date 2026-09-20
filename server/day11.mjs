import { estimateMessagesTokens } from "./token-counter.mjs";

function formatItems(title, items) {
  if (items.length === 0) {
    return null;
  }
  return {
    role: "system",
    content: `${title}:\n${items.map((item) => `- ${item.key}: ${item.value}`).join("\n")}`,
  };
}

function buildMemoryMessages({ layers, messages }) {
  return [
    formatItems("Краткосрочные записи", layers.shortTerm),
    formatItems("Рабочая память текущей задачи", layers.working),
    formatItems("Долговременная память пользователя", layers.longTerm),
    ...messages.map(({ role, content }) => ({ role, content })),
  ].filter(Boolean);
}

export class MemoryLayerAgent {
  constructor({ apiKey, maxTokens, memoryState, model, requestLlm, systemPrompt, temperature }) {
    this.apiKey = apiKey;
    this.maxTokens = maxTokens;
    this.memoryState = memoryState;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async compare(userMessage) {
    const base = [{ role: "system", content: this.systemPrompt }];
    const withoutMemoryMessages = [...base, { role: "user", content: userMessage }];
    const withMemoryMessages = [
      ...base,
      ...buildMemoryMessages(this.memoryState),
      { role: "user", content: userMessage },
    ];
    const request = (messages) =>
      this.requestLlm({
        apiKey: this.apiKey,
        maxTokens: this.maxTokens,
        messages,
        model: this.model,
        temperature: this.temperature,
      });

    const [withoutMemory, withMemory] = await Promise.all([
      request(withoutMemoryMessages),
      request(withMemoryMessages),
    ]);

    return {
      responses: { withoutMemory, withMemory },
      context: {
        withoutMemoryMessages: withoutMemoryMessages.length,
        withMemoryMessages: withMemoryMessages.length,
        shortTermMessages: this.memoryState.messages.length,
        layerItems: Object.fromEntries(
          Object.entries(this.memoryState.layers).map(([layer, items]) => [layer, items.length]),
        ),
      },
      tokenCounts: {
        estimatedWithoutMemory: estimateMessagesTokens(withoutMemoryMessages),
        estimatedWithMemory: estimateMessagesTokens(withMemoryMessages),
        actualWithoutMemory: withoutMemory.usage?.prompt_tokens ?? null,
        actualWithMemory: withMemory.usage?.prompt_tokens ?? null,
      },
    };
  }
}
