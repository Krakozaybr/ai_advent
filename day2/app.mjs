import { askOpenRouter, getModel, saveResult } from "../lib/openrouter.mjs";

const prompt = "Объясни разницу между let и const в JavaScript.";
const constrainedPrompt = `${prompt}

Формат: две строки вида «let: ...» и «const: ...».
Длина: не более 35 слов всего.
Завершение: после строки «END» больше ничего не пиши.`;

try {
  const model = getModel();
  const [withoutConstraints, withConstraints] = await Promise.all([
    askOpenRouter({ model, prompt }),
    askOpenRouter({ model, prompt: constrainedPrompt }),
  ]);

  const result = {
    model,
    prompt,
    withoutConstraints,
    withConstraints: { ...withConstraints, prompt: constrainedPrompt },
  };
  await saveResult("day2/result.json", result);

  console.log("Без ограничений:\n", withoutConstraints.answer);
  console.log("\nС ограничениями:\n", withConstraints.answer);
  console.log("\nПолный результат: day2/result.json");
} catch (error) {
  console.error(`Ошибка Day 2: ${error.message}`);
  process.exitCode = 1;
}
