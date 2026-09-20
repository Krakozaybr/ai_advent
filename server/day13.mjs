export class TaskStateAgent {
  constructor({ apiKey, history, maxTokens, model, requestLlm, systemPrompt, task, temperature }) {
    this.apiKey = apiKey;
    this.history = history;
    this.maxTokens = maxTokens;
    this.model = model;
    this.requestLlm = requestLlm;
    this.systemPrompt = systemPrompt;
    this.task = task;
    this.temperature = temperature;
  }

  async respond(userMessage) {
    const stateMessage = {
      role: "system",
      content: `Состояние задачи:
- Название: ${this.task.title}
- Этап: ${this.task.phase}
- Текущий шаг: ${this.task.currentStep}
- Ожидаемое действие: ${this.task.expectedAction}
- Пауза: ${this.task.paused ? "да" : "нет"}`,
    };
    const messages = [
      { role: "system", content: this.systemPrompt },
      stateMessage,
      ...this.history.map(({ role, content }) => ({ role, content })),
      { role: "user", content: userMessage },
    ];
    return this.requestLlm({
      apiKey: this.apiKey,
      maxTokens: this.maxTokens,
      messages,
      model: this.model,
      temperature: this.temperature,
    });
  }
}
