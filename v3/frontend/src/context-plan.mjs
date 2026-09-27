export function estimateTokens(text) {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

export function planContext(transcript, prompt, options) {
  const { strategy, windowSize, summary, summaryWatermark, budgetTokens, responseTokensEstimate } = options;
  const history = transcript.filter((message) => message.content.length > 0);
  let messages;
  if (strategy === "full") messages = history;
  else if (strategy === "sliding_window") messages = history.slice(-windowSize);
  else messages = [
    ...(summary.trim() ? [{ role: "user", content: `Сводка предыдущего диалога (до watermark ${summaryWatermark || "не задан"}):\n${summary}` }] : []),
    ...history.slice(-windowSize),
  ];
  const historyTokensEstimate = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  const currentMessageTokensEstimate = estimateTokens(prompt);
  const inputTokensEstimate = historyTokensEstimate + currentMessageTokensEstimate;
  const responseTokens = responseTokensEstimate || 1024;
  return {
    messages,
    omittedMessages: strategy === "full" ? 0 : Math.max(0, history.length - Math.min(history.length, windowSize)),
    historyTokensEstimate,
    currentMessageTokensEstimate,
    inputTokensEstimate,
    responseTokensEstimate: responseTokens,
    budgetTokens,
    overflow: inputTokensEstimate + responseTokens > budgetTokens,
    summaryMissing: strategy === "summary_window" && !summary.trim(),
    estimateKind: "оценка по длине текста; не измерение токенизатора провайдера",
  };
}
