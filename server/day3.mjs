import { DAY3_EXPECTED_ANSWER, DEFAULT_DAY3_TASK } from "../shared/day3.js";

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

function aggregateUsage(results) {
  const total = (name) =>
    results.reduce((sum, result) => sum + Number(result.usage?.[name] || 0), 0);

  return {
    prompt_tokens: total("prompt_tokens"),
    completion_tokens: total("completion_tokens"),
    total_tokens: total("total_tokens"),
  };
}

function containsExpectedAnswer(answer) {
  return new RegExp(`(^|\\D)${DAY3_EXPECTED_ANSWER}(\\D|$)`, "u").test(answer);
}

export async function runDay3Method({
  apiKey,
  instruction,
  maxTokens,
  method,
  model,
  requestLlm,
  task,
}) {
  const calls = [];
  let generatedPrompt = null;

  if (method === "meta") {
    const promptDesign = await requestLlm({
      apiKey,
      model,
      prompt: `${instruction}\n\nЗадача:\n${task}`,
      maxTokens: Math.min(maxTokens, 400),
    });
    calls.push({ label: "Генерация prompt", ...promptDesign });
    generatedPrompt = promptDesign.answer;

    const solution = await requestLlm({
      apiKey,
      model,
      prompt: `${generatedPrompt}\n\nЗаверши ответ строкой «Итоговый ответ: <число>».`,
      maxTokens,
    });
    calls.push({ label: "Решение по созданному prompt", ...solution });
  } else {
    const solution = await requestLlm({
      apiKey,
      model,
      prompt: `${task}\n\n${instruction}`,
      maxTokens,
    });
    calls.push({ label: "Решение", ...solution });
  }

  const finalCall = calls.at(-1);
  const canCheckAutomatically = task === DEFAULT_DAY3_TASK;

  return {
    method,
    answer: finalCall.answer,
    model: finalCall.model,
    usage: aggregateUsage(calls),
    cost: calls.reduce((sum, call) => sum + Number(call.cost || 0), 0),
    latencyMs: calls.reduce((sum, call) => sum + Number(call.latencyMs || 0), 0),
    wordCount: countWords(finalCall.answer),
    correct: canCheckAutomatically ? containsExpectedAnswer(finalCall.answer) : null,
    expectedAnswer: canCheckAutomatically ? DAY3_EXPECTED_ANSWER : null,
    generatedPrompt,
    calls,
  };
}
