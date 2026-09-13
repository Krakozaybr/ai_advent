export function estimateTextTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

export function estimateMessagesTokens(messages) {
  const messageTokens = messages.reduce(
    (total, message) => total + 4 + estimateTextTokens(message.content),
    0,
  );
  return messageTokens + 2;
}
