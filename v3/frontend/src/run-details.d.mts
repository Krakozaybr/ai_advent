export function tokenizeJson(source: string): Array<{ text: string; kind: "plain" | "key" | "string" | "number" | "literal" | "punctuation" }>;
export function wasConfigurationChanged(previous: Record<string, unknown> | null, current: Record<string, unknown> | null): boolean;
