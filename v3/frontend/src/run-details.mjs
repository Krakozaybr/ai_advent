const JSON_TOKENS = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\]:,]/g;

export function tokenizeJson(source) {
  const tokens = [];
  let cursor = 0;
  for (const match of source.matchAll(JSON_TOKENS)) {
    if (match.index > cursor) tokens.push({ text: source.slice(cursor, match.index), kind: "plain" });
    const text = match[0];
    const kind = text.startsWith('"') ? (/^\s*:/.test(source.slice(match.index + text.length)) ? "key" : "string")
      : /^[\d-]/.test(text) ? "number" : /^(true|false|null)$/.test(text) ? "literal" : "punctuation";
    tokens.push({ text, kind });
    cursor = match.index + text.length;
  }
  if (cursor < source.length) tokens.push({ text: source.slice(cursor), kind: "plain" });
  return tokens;
}

const CONFIG_KEYS = ["provider", "model", "effort", "serviceTier", "temperature", "maxTokens", "stop", "contextStrategy", "effectiveInstructions"];

export function wasConfigurationChanged(previous, current) {
  if (!previous || !current) return false;
  return CONFIG_KEYS.some((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(current[key] ?? null));
}
