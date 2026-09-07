import { writeFile } from "node:fs/promises";
import { askCodex } from "../lib/codex.mjs";

const prompt = `Найди трёхзначное число. Его цифры различны, сумма цифр равна 12,
десятки на 2 больше единиц, а сотни на 1 меньше десятков. Назови число и кратко обоснуй ответ.`;
const expectedAnswer = "543";
const models = [
  ["weak", "gpt-5.6-luna"],
  ["medium", "gpt-5.6-terra"],
  ["strong", "gpt-5.6-sol"],
];

function answerLooksCorrect(answer) {
  return new RegExp(`(^|\\D)${expectedAnswer}(\\D|$)`).test(answer);
}

try {
  const results = await Promise.all(models.map(async ([level, requestedModel]) => {
    const response = await askCodex(prompt, requestedModel);
    return {
      level,
      requestedModel,
      ...response,
      qualityProxy: { containsExpectedAnswer: answerLooksCorrect(response.answer) },
    };
  }));
  const result = {
    prompt,
    expectedAnswer,
    results,
    notes: "Качество оценивается по наличию правильного числа; полноту обоснования нужно сравнить по текстам ответов. Codex app-server не предоставляет токены и стоимость запроса.",
  };
  await writeFile("day5/result.json", `${JSON.stringify(result, null, 2)}\n`);

  console.table(results.map(({ level, model, latencyMs, usage, cost, qualityProxy }) => ({
    level,
    model,
    latencyMs,
    totalTokens: usage?.total_tokens ?? "н/д (Codex)",
    cost: cost ?? "н/д (подписка Codex)",
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
