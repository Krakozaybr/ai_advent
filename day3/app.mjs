import { writeFile } from "node:fs/promises";
import { askCodex } from "../lib/codex.mjs";

const task = `Найди трёхзначное число. Его цифры различны, сумма цифр равна 12,
десятки на 2 больше единиц, а сотни на 1 меньше десятков. Назови число и обоснуй ответ.`;
const expectedAnswer = "543";

function isCorrect(answer) {
  return new RegExp(`(^|\\D)${expectedAnswer}(\\D|$)`).test(answer);
}

try {
  const [direct, stepByStep, experts, promptDesign] = await Promise.all([
    askCodex(task),
    askCodex(`${task}\nРешай пошагово.`),
    askCodex(`${task}

Дай три независимых мини-решения с заголовками:
«Аналитик», «Инженер», «Критик». Критик обязан проверить выводы остальных.`),
    askCodex(`Составь короткий, точный prompt для другой модели, чтобы она решила задачу.
Не решай её сам.\n\nЗадача:\n${task}`),
  ]);

  const promptThenSolve = await askCodex(promptDesign.answer);
  const approaches = {
    direct,
    stepByStep,
    promptThenSolve: { ...promptThenSolve, generatedPrompt: promptDesign.answer },
    experts,
  };
  const comparison = Object.fromEntries(
    Object.entries(approaches).map(([name, result]) => [name, {
      containsExpectedAnswer: isCorrect(result.answer),
      latencyMs: result.latencyMs,
    }]),
  );
  const result = { model: direct.model, task, expectedAnswer, approaches, comparison };
  await writeFile("day3/result.json", `${JSON.stringify(result, null, 2)}\n`);

  for (const [name, answer] of Object.entries(approaches)) {
    console.log(`\n${name}:\n${answer.answer}`);
  }
  console.log("\nСравнение:", comparison);
  console.log("Полный результат: day3/result.json");
} catch (error) {
  console.error(`Ошибка Day 3: ${error.message}`);
  process.exitCode = 1;
}
