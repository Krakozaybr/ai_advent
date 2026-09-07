import { askOpenRouter, getModel, saveResult } from "../lib/openrouter.mjs";

const prompt = "Придумай одно предложение научно-фантастического сюжета об исследователе Марса. Не больше 25 слов.";
const temperatures = [0, 0.7, 1.2];

function words(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) || [];
}

function jaccard(left, right) {
  const a = new Set(words(left));
  const b = new Set(words(right));
  const union = new Set([...a, ...b]);
  const shared = [...a].filter((word) => b.has(word));
  return union.size === 0 ? 0 : shared.length / union.size;
}

function metrics(answer, otherAnswers) {
  const answerWords = words(answer);
  const uniqueWords = new Set(answerWords).size;
  const averageSimilarity = otherAnswers.length === 0
    ? 0
    : otherAnswers.reduce((sum, other) => sum + jaccard(answer, other), 0) / otherAnswers.length;

  return {
    accuracyProxy: {
      containsMars: /марс/i.test(answer),
      wordLimitMet: answerWords.length <= 25,
    },
    creativityProxy: uniqueWords,
    diversityProxy: Number((1 - averageSimilarity).toFixed(3)),
    wordCount: answerWords.length,
  };
}

try {
  const model = getModel();
  const responses = await Promise.all(
    temperatures.map(async (temperature) => ({
      temperature,
      ...(await askOpenRouter({
        model,
        prompt,
        temperature,
        provider: { allow_fallbacks: false, require_parameters: true },
      })),
    })),
  );
  const variants = responses.map((response) => ({
    ...response,
    metrics: metrics(response.answer, responses.filter((other) => other !== response).map((other) => other.answer)),
  }));
  const result = {
    model,
    prompt,
    variants,
    notes: "Точность — соблюдение темы и лимита слов; креативность и разнообразие — ориентиры для сравнения, а не объективная оценка качества.",
  };
  await saveResult("day4/result.json", result);

  for (const variant of variants) {
    console.log(`\ntemperature = ${variant.temperature}:\n${variant.answer}`);
    console.log(variant.metrics);
  }
  console.log("\nПолный результат: day4/result.json");
} catch (error) {
  console.error(`Ошибка Day 4: ${error.message}`);
  process.exitCode = 1;
}
