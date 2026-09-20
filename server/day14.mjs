function findConflicts(message, invariants) {
  const normalized = message.toLocaleLowerCase("ru-RU");
  return invariants
    .map((invariant) => ({
      invariant,
      matchedTerms: invariant.forbiddenTerms.filter((term) =>
        normalized.includes(term.toLocaleLowerCase("ru-RU")),
      ),
    }))
    .filter((result) => result.matchedTerms.length > 0);
}

export class InvariantAgent {
  constructor({ apiKey, invariants, maxTokens, model, requestLlm, systemPrompt, temperature }) {
    this.apiKey = apiKey;
    this.invariants = invariants;
    this.maxTokens = maxTokens;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  check(userMessage) {
    return findConflicts(userMessage, this.invariants);
  }

  async respond(userMessage) {
    const conflicts = this.check(userMessage);
    if (conflicts.length > 0) {
      return {
        blocked: true,
        answer: `Запрос отклонён: он нарушает ${conflicts.length} инвариант(а). Измените запрос или явно пересмотрите ограничения задачи.`,
        conflicts,
        response: null,
      };
    }
    const invariantMessage = {
      role: "system",
      content: `Инварианты задачи:\n${this.invariants.map((item) => `- [${item.category}] ${item.rule}`).join("\n")}`,
    };
    const response = await this.requestLlm({
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      messages: [
        { role: "system", content: this.systemPrompt },
        invariantMessage,
        { role: "user", content: userMessage },
      ],
      model: this.model,
      temperature: this.temperature,
    });
    return { blocked: false, answer: response.answer, conflicts: [], response };
  }
}
