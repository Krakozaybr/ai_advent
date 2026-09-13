import { DEFAULT_DAY4_PROMPT } from "../shared/day4.js";

function words(text) {
  return text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]+/gu) || [];
}

function countLabels(answer, label) {
  return answer.match(new RegExp(`${label}\\s*:`, "giu"))?.length || 0;
}

function checkDefaultFormat(answer) {
  const labels = {
    names: countLabels(answer, "Название"),
    slogans: countLabels(answer, "Слоган"),
    benefits: countLabels(answer, "Польза"),
  };
  const russianOnly = !/[a-z]/iu.test(answer);

  return {
    passed: Object.values(labels).every((count) => count === 3) && russianOnly,
    labels,
    russianOnly,
  };
}

export async function runDay4Experiment({
  apiKey,
  maxTokens,
  model,
  prompt,
  requestLlm,
  temperature,
}) {
  const result = await requestLlm({ apiKey, maxTokens, model, prompt, temperature });
  const answerWords = words(result.answer);
  const formatCheck = prompt === DEFAULT_DAY4_PROMPT ? checkDefaultFormat(result.answer) : null;

  return {
    ...result,
    temperature,
    wordCount: answerWords.length,
    lexicalDiversity:
      answerWords.length === 0
        ? 0
        : Math.round((new Set(answerWords).size / answerWords.length) * 1000) / 10,
    formatCorrect: formatCheck?.passed ?? null,
    formatDetails: formatCheck,
  };
}
