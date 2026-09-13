import { DEFAULT_DAY5_PROMPT } from "../shared/day5.js";

function countWords(text) {
  return text.match(/[\p{L}\p{N}]+/gu)?.length || 0;
}

function checkDefaultAnswer(answer) {
  const checks = {
    code: /```(?:js|javascript)?[\s\S]*```/iu.test(answer),
    expectedResult: /[`"'«]\s*к\s*[`"'»]/iu.test(answer),
    linearComplexity: /O\s*\(\s*n\s*\)/iu.test(answer),
    unicode: /Array\.from|\[\s*\.\.\.|for\s*\([^)]*\bof\b/iu.test(answer),
    nullFallback: /\bnull\b/iu.test(answer),
  };

  return {
    checks,
    score: Object.values(checks).filter(Boolean).length,
    total: Object.keys(checks).length,
  };
}

export async function runDay5Experiment({
  apiKey,
  maxTokens,
  model,
  prompt,
  requestLlm,
  temperature,
}) {
  const result = await requestLlm({ apiKey, maxTokens, model, prompt, temperature });

  return {
    ...result,
    wordCount: countWords(result.answer),
    qualityCheck: prompt === DEFAULT_DAY5_PROMPT ? checkDefaultAnswer(result.answer) : null,
  };
}
