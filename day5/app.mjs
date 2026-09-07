import { askOpenRouter, saveResult } from "../lib/openrouter.mjs";

const prompt = `Найди трёхзначное число. Его цифры различны, сумма цифр равна 12,
десятки на 2 больше единиц, а сотни на 1 меньше десятков. Назови число и кратко обоснуй ответ.`;
const expectedAnswer = "543";
const models = [
  ["weak", process.env.DAY5_WEAK_MODEL],
  ["medium", process.env.DAY5_MEDIUM_MODEL],
  ["strong", process.env.DAY5_STRONG_MODEL],
];

function modelConfigs() {
  const missing = models.filter(([, model]) => !model).map(([level]) => `DAY5_${level.toUpperCase()}_MODEL`);
  if (missing.length > 0) {
    throw new Error(`Укажи модели: ${missing.join(", ")}.`);
  }
  return models.map(([level, model]) => ({ level, model }));
}

function answerLooksCorrect(answer) {
  return new RegExp(`(^|\\D)${expectedAnswer}(\\D|$)`).test(answer);
}

try {
  const results = await Promise.all(modelConfigs().map(async ({ level, model }) => {
    const response = await askOpenRouter({
      model,
      prompt,
      temperature: 0,
      provider: { allow_fallbacks: false, require_parameters: true },
    });
    return {
      level,
      requestedModel: model,
      ...response,
      qualityProxy: { containsExpectedAnswer: answerLooksCorrect(response.answer) },
    };
  }));
  const result = {
    prompt,
    expectedAnswer,
    results,
    modelCatalog: "https://openrouter.ai/api/v1/models",
    notes: "Качество оценивается по наличию правильного числа; полноту обоснования нужно сравнить по текстам ответов.",
  };
  await saveResult("day5/result.json", result);

  console.table(results.map(({ level, model, latencyMs, usage, cost, qualityProxy }) => ({
    level,
    model,
    latencyMs,
    totalTokens: usage?.total_tokens,
    cost,
    correct: qualityProxy.containsExpectedAnswer,
  })));
  for (const resultItem of results) {
    console.log(`\n${resultItem.level} (${resultItem.model}):\n${resultItem.answer}`);
  }
  console.log("\nПолный результат: day5/result.json");
} catch (error) {
  console.error(`Ошибка Day 5: ${error.message}`);
  process.exitCode = 1;
}
