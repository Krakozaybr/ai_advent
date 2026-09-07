import { writeFile } from "node:fs/promises";
import { askCodex } from "../lib/codex.mjs";

const prompt = "Объясни разницу между let и const в JavaScript.";
const constrainedPrompt = `${prompt}

Формат: две строки вида «let: ...» и «const: ...».
Длина: не более 35 слов всего.
Завершение: после строки «END» больше ничего не пиши.`;

try {
  const [withoutConstraints, withConstraints] = await Promise.all([
    askCodex(prompt),
    askCodex(constrainedPrompt),
  ]);

  const result = {
    model: withoutConstraints.model,
    prompt,
    withoutConstraints,
    withConstraints: { ...withConstraints, prompt: constrainedPrompt },
  };
  await writeFile("day2/result.json", `${JSON.stringify(result, null, 2)}\n`);

  console.log("Без ограничений:\n", withoutConstraints.answer);
  console.log("\nС ограничениями:\n", withConstraints.answer);
  console.log("\nПолный результат: day2/result.json");
} catch (error) {
  console.error(`Ошибка Day 2: ${error.message}`);
  process.exitCode = 1;
}
