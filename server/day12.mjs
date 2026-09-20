import { estimateMessagesTokens } from "./token-counter.mjs";

function formatProfile(profile) {
  return {
    role: "system",
    content: `Профиль пользователя:
- Имя профиля: ${profile.name}
- Уровень: ${profile.expertise}
- Стиль: ${profile.style}
- Формат: ${profile.format}
- Ограничения: ${profile.constraints}
- Язык: ${profile.language}`,
  };
}

function formatMemory(memoryState) {
  const layerNames = {
    shortTerm: "Краткосрочная память",
    working: "Рабочая память",
    longTerm: "Долговременная память",
  };
  const layerMessages = Object.entries(memoryState.layers)
    .filter(([, items]) => items.length > 0)
    .map(([layer, items]) => ({
      role: "system",
      content: `${layerNames[layer]}:\n${items.map((item) => `- ${item.key}: ${item.value}`).join("\n")}`,
    }));
  return [
    ...layerMessages,
    ...memoryState.messages.map(({ role, content }) => ({ role, content })),
  ];
}

export class PersonalizedAgent {
  constructor({ apiKey, maxTokens, memoryState, model, requestLlm, systemPrompt, temperature }) {
    this.apiKey = apiKey;
    this.maxTokens = maxTokens;
    this.memoryState = memoryState;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async compare(userMessage, profiles) {
    const commonMemory = formatMemory(this.memoryState);
    const runs = await Promise.all(
      profiles.map(async (profile) => {
        const messages = [
          { role: "system", content: this.systemPrompt },
          formatProfile(profile),
          ...commonMemory,
          { role: "user", content: userMessage },
        ];
        const response = await this.requestLlm({
          apiKey: this.apiKey,
          maxTokens: this.maxTokens,
          messages,
          model: this.model,
          temperature: this.temperature,
        });
        return {
          profile,
          response,
          context: {
            messages: messages.length,
            estimatedInputTokens: estimateMessagesTokens(messages),
            actualInputTokens: response.usage?.prompt_tokens ?? null,
          },
        };
      }),
    );

    return {
      runs,
      memory: {
        dialogueMessages: this.memoryState.messages.length,
        items: Object.values(this.memoryState.layers).reduce((sum, items) => sum + items.length, 0),
      },
    };
  }
}
