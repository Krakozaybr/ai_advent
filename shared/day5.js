export const DEFAULT_DAY5_PROMPT = `Напиши JavaScript-функцию firstUniqueCharacter(text), которая возвращает первый символ, встречающийся ровно один раз, или null.

Требования:
- корректно обрабатывай Unicode-символы, включая emoji;
- сложность алгоритма должна быть O(n);
- покажи результат для строки «абракадабра🙂🙂я»;
- добавь короткое объяснение решения.`;

export const DAY5_PROFILES = {
  weak: {
    title: "Слабая",
    name: "Qwen2.5 7B Instruct",
    size: "7B параметров",
    model: "qwen/qwen-2.5-7b-instruct",
    url: "https://openrouter.ai/qwen/qwen-2.5-7b-instruct",
  },
  medium: {
    title: "Средняя",
    name: "Qwen3 30B A3B Instruct 2507",
    size: "30.5B всего, 3.3B активных",
    model: "qwen/qwen3-30b-a3b-instruct-2507",
    url: "https://openrouter.ai/qwen/qwen3-30b-a3b-instruct-2507",
  },
  strong: {
    title: "Сильная",
    name: "Qwen3 235B A22B Instruct 2507",
    size: "235B всего, 22B активных",
    model: "qwen/qwen3-235b-a22b-2507",
    url: "https://openrouter.ai/qwen/qwen3-235b-a22b-2507",
  },
};
