function countWords(text) {
  return text.match(/[\p{L}\p{N}]+/gu)?.length || 0;
}

export class LlmAgent {
  constructor({
    apiKey,
    history = [],
    maxTokens,
    model,
    requestLlm,
    systemPrompt,
    temperature,
  }) {
    this.apiKey = apiKey;
    this.history = history.map((message) => ({ ...message }));
    this.maxTokens = maxTokens;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async respond(userMessage) {
    const nextUserMessage = { role: "user", content: userMessage };
    const messages = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
      nextUserMessage,
    ];
    const response = await this.requestLlm({
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      messages,
      model: this.model,
      temperature: this.temperature,
    });

    this.history.push(nextUserMessage, { role: "assistant", content: response.answer });
    return { ...response, wordCount: countWords(response.answer) };
  }

  getHistory() {
    return this.history.map((message) => ({ ...message }));
  }
}
