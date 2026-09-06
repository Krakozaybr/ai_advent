const prompt = process.argv.slice(2).join(" ") || "Привет! Ответь одной короткой фразой.";
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-5-mini";

if (!apiKey) {
  console.error("Не задан OPENAI_API_KEY.");
  process.exit(1);
}

try {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: prompt }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  const answer = data.output
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");

  console.log(answer || "Модель не вернула текстовый ответ.");
} catch (error) {
  console.error(`Ошибка запроса к API: ${error.message}`);
  process.exit(1);
}
