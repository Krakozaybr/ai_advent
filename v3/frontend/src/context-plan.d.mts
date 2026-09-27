export type ContextMessage = { role: string; content: string };
export type ContextStrategy = "full" | "sliding_window" | "summary_window";
export type ContextPlan = {
  messages: ContextMessage[];
  omittedMessages: number;
  historyTokensEstimate: number;
  currentMessageTokensEstimate: number;
  inputTokensEstimate: number;
  responseTokensEstimate: number;
  budgetTokens: number;
  overflow: boolean;
  summaryMissing: boolean;
  estimateKind: string;
};
export function estimateTokens(text: string): number;
export function planContext(transcript: ContextMessage[], prompt: string, options: {
  strategy: ContextStrategy;
  windowSize: number;
  summary: string;
  summaryWatermark?: string;
  budgetTokens: number;
  responseTokensEstimate: number;
}): ContextPlan;
