import { estimateMessagesTokens, estimateTextTokens } from "./token-counter.mjs";

function formatHistory(messages) {
  return messages
    .map((message, index) => `${index + 1}. ${message.role}: ${message.content}`)
    .join("\n");
}

function buildSummaryMessages(currentSummary, messagesToSummarize) {
  return [
    {
      role: "system",
      content:
        "Ты обновляешь краткую память диалога. Сохрани имена, числа, ограничения, предпочтения и принятые решения. Не добавляй новых фактов. Верни только компактный Markdown-список.",
    },
    {
      role: "user",
      content: `Текущее summary:\n${currentSummary || "(пока пусто)"}\n\nНовые старые сообщения:\n${formatHistory(messagesToSummarize)}\n\nОбнови summary.`,
    },
  ];
}

export class ContextCompressionAgent {
  constructor({
    apiKey,
    fullHistory,
    compressedHistory,
    keepLast,
    maxTokens,
    model,
    requestLlm,
    summarizedMessageCount,
    summary,
    summaryMaxTokens,
    systemPrompt,
    temperature,
  }) {
    this.apiKey = apiKey;
    this.fullHistory = fullHistory;
    this.compressedHistory = compressedHistory;
    this.keepLast = keepLast;
    this.maxTokens = maxTokens;
    this.model = model;
    this.requestLlm = requestLlm;
    this.summarizedMessageCount = summarizedMessageCount;
    this.summary = summary;
    this.summaryMaxTokens = summaryMaxTokens;
    this.systemPrompt = systemPrompt;
    this.temperature = temperature;
  }

  async compare(userMessage) {
    const compressionBoundary = Math.max(
      this.summarizedMessageCount,
      this.compressedHistory.length - this.keepLast,
    );
    const messagesToSummarize = this.compressedHistory.slice(
      this.summarizedMessageCount,
      compressionBoundary,
    );
    let nextSummary = this.summary;
    let summaryResponse = null;

    if (messagesToSummarize.length > 0) {
      const summaryMessages = buildSummaryMessages(this.summary, messagesToSummarize);
      summaryResponse = await this.requestLlm({
        apiKey: this.apiKey,
        maxTokens: this.summaryMaxTokens,
        messages: summaryMessages,
        model: this.model,
        temperature: 0,
      });
      nextSummary = summaryResponse.answer.trim();
      if (!nextSummary) {
        throw new Error("Модель вернула пустой summary. История оставлена без изменений.");
      }
    }

    const recentHistory = this.compressedHistory.slice(compressionBoundary);
    const fullMessages = [
      { role: "system", content: this.systemPrompt },
      ...this.fullHistory,
      { role: "user", content: userMessage },
    ];
    const compressedMessages = [
      { role: "system", content: this.systemPrompt },
      ...(nextSummary
        ? [{ role: "system", content: `Summary старой части диалога:\n${nextSummary}` }]
        : []),
      ...recentHistory,
      { role: "user", content: userMessage },
    ];

    const [fullResponse, compressedResponse] = await Promise.all([
      this.requestLlm({
        apiKey: this.apiKey,
        maxTokens: this.maxTokens,
        messages: fullMessages,
        model: this.model,
        temperature: this.temperature,
      }),
      this.requestLlm({
        apiKey: this.apiKey,
        maxTokens: this.maxTokens,
        messages: compressedMessages,
        model: this.model,
        temperature: this.temperature,
      }),
    ]);

    const estimatedFullInput = estimateMessagesTokens(fullMessages);
    const estimatedCompressedInput = estimateMessagesTokens(compressedMessages);

    return {
      responses: {
        full: fullResponse,
        compressed: compressedResponse,
      },
      summary: {
        text: nextSummary,
        summarizedMessageCount: compressionBoundary,
        summarizedNow: messagesToSummarize.length,
        keptRecentMessages: recentHistory.length,
        response: summaryResponse,
      },
      tokenCounts: {
        currentMessage: estimateTextTokens(userMessage),
        summary: estimateTextTokens(nextSummary),
        estimatedFullInput,
        estimatedCompressedInput,
        estimatedSaved: Math.max(0, estimatedFullInput - estimatedCompressedInput),
        actualFullInput: fullResponse.usage?.prompt_tokens ?? null,
        actualCompressedInput: compressedResponse.usage?.prompt_tokens ?? null,
        actualSaved:
          fullResponse.usage?.prompt_tokens != null &&
          compressedResponse.usage?.prompt_tokens != null
            ? fullResponse.usage.prompt_tokens - compressedResponse.usage.prompt_tokens
            : null,
        summaryInput: summaryResponse?.usage?.prompt_tokens ?? null,
        summaryOutput: summaryResponse?.usage?.completion_tokens ?? null,
      },
    };
  }
}
