import { useState } from "react";
import { DAY4_PROFILES, DEFAULT_DAY4_PROMPT } from "../shared/day4.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Выполните один и тот же запрос с параметрами:

- 👉 temperature = 0
- 👉 temperature = 0.7
- 👉 temperature = 1.2

Сравните ответы по точности, креативности и разнообразию.

Сформулируйте, для каких задач лучше подходит каждая настройка.

**Результат:** примеры ответов с разной температурой и выводы по их использованию.`;

const PROFILE_DESCRIPTIONS = {
  precise: "Минимум случайности: ответ должен быть наиболее предсказуемым и аккуратным.",
  balanced: "Баланс соблюдения инструкции и вариативности формулировок.",
  creative: "Больше случайности: идеи могут быть необычнее, но риск нарушения формата выше.",
};

const DEFAULT_TEMPERATURES = Object.fromEntries(
  Object.entries(DAY4_PROFILES).map(([id, profile]) => [id, profile.temperature]),
);
const EMPTY_RESULTS = { precise: null, balanced: null, creative: null };
const EMPTY_ERRORS = { precise: "", balanced: "", creative: "" };
const EMPTY_LOADING = { precise: false, balanced: false, creative: false };

function answerWords(answer) {
  return new Set(answer.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]+/gu) || []);
}

function differenceFromOthers(id, results) {
  const ownWords = answerWords(results[id].answer);
  const similarities = Object.entries(results)
    .filter(([otherId]) => otherId !== id)
    .map(([, result]) => {
      const otherWords = answerWords(result.answer);
      const intersection = [...ownWords].filter((word) => otherWords.has(word)).length;
      const union = new Set([...ownWords, ...otherWords]).size;
      return union === 0 ? 1 : intersection / union;
    });

  const averageSimilarity =
    similarities.reduce((sum, similarity) => sum + similarity, 0) / similarities.length;
  return Math.round((1 - averageSimilarity) * 100);
}

function buildComparison(results) {
  const rows = Object.entries(DAY4_PROFILES).map(([id, profile]) => {
    const result = results[id];
    const accuracy =
      result.formatCorrect == null ? "не проверяется" : result.formatCorrect ? "формат соблюдён" : "есть нарушения";
    return `| ${profile.title} | ${result.temperature} | ${accuracy} | ${result.lexicalDiversity}% | ${differenceFromOthers(id, results)}% | ${result.usage?.total_tokens ?? "н/д"} | ${result.latencyMs} мс | $${Number(result.cost || 0).toFixed(6)} |`;
  });
  const mostDifferent = Object.keys(results).reduce((bestId, id) =>
    differenceFromOthers(id, results) > differenceFromOthers(bestId, results) ? id : bestId,
  );

  return `В этом запуске сильнее всего от остальных отличается ответ **${DAY4_PROFILES[mostDifferent].title.toLocaleLowerCase("ru-RU")}** с temperature = **${results[mostDifferent].temperature}**.

| Режим | Temperature | Точность формата | Уникальных слов | Отличие от других | Токенов | Время | Стоимость |
|---|---:|---|---:|---:|---:|---:|---:|
${rows.join("\n")}

### Когда использовать

- **0** — извлечение данных, классификация, проверяемые задачи и стабильный формат.
- **0.7** — обычные тексты, объяснения и идеи с умеренной вариативностью.
- **1.2** — мозговой штурм и поиск неожиданных вариантов; факты и формат нужно проверять внимательнее.

> «Уникальных слов» и «Отличие от других» — простые эвристики разнообразия, а не объективная оценка креативности. Для строгого эксперимента каждый режим стоит запустить несколько раз.`;
}

function downloadResult(id, settings, result) {
  const payload = { profile: id, settings, result };
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day4-temperature-${result.temperature}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Day4({ hasApiKey, onOpenSettings }) {
  const [activeProfile, setActiveProfile] = useState("precise");
  const [prompt, setPrompt] = useState(DEFAULT_DAY4_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(550);
  const [temperatures, setTemperatures] = useState(DEFAULT_TEMPERATURES);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [errors, setErrors] = useState(EMPTY_ERRORS);
  const [loading, setLoading] = useState(EMPTY_LOADING);

  const profile = DAY4_PROFILES[activeProfile];
  const result = results[activeProfile];
  const anyLoading = Object.values(loading).some(Boolean);
  const hasEmptyTemperature = Object.values(temperatures).some((value) => value === "");
  const allReady = Object.values(results).every(Boolean);

  function clearResults() {
    setResults(EMPTY_RESULTS);
    setErrors(EMPTY_ERRORS);
  }

  function updateShared(setter, value) {
    setter(value);
    clearResults();
  }

  function updateTemperature(value) {
    setTemperatures((current) => ({ ...current, [activeProfile]: value }));
    setResults((current) => ({ ...current, [activeProfile]: null }));
    setErrors((current) => ({ ...current, [activeProfile]: "" }));
  }

  async function runProfile(id) {
    const settings = {
      prompt,
      model,
      maxTokens: Number(maxTokens),
      temperature: Number(temperatures[id]),
    };
    setLoading((current) => ({ ...current, [id]: true }));
    setResults((current) => ({ ...current, [id]: null }));
    setErrors((current) => ({ ...current, [id]: "" }));

    try {
      const nextResult = await apiRequest("/api/day4/run", {
        method: "POST",
        body: JSON.stringify(settings),
      });
      setResults((current) => ({ ...current, [id]: nextResult }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [id]: requestError.message }));
    } finally {
      setLoading((current) => ({ ...current, [id]: false }));
    }
  }

  function resetAll() {
    setPrompt(DEFAULT_DAY4_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(550);
    setTemperatures(DEFAULT_TEMPERATURES);
    clearResults();
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 4</p>
          <h2>Температура</h2>
          <p className="muted">Сравни один prompt при трёх уровнях случайности.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Перед первым запросом добавь ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">
            Открыть настройки
          </button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <div className="experiment-form shared-task">
        <label>
          Один prompt для всех температур
          <textarea
            disabled={anyLoading}
            onChange={(event) => updateShared(setPrompt, event.target.value)}
            rows="9"
            value={prompt}
          />
        </label>
        <div className="field-grid">
          <label>
            Модель OpenRouter
            <input
              disabled={anyLoading}
              onChange={(event) => updateShared(setModel, event.target.value)}
              value={model}
            />
          </label>
          <label>
            Максимум токенов
            <input
              disabled={anyLoading}
              max="8192"
              min="1"
              onChange={(event) => updateShared(setMaxTokens, event.target.value)}
              type="number"
              value={maxTokens}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled={anyLoading} onClick={resetAll} type="button">
            Сбросить всё
          </button>
          <button
            className="primary-button"
            disabled={anyLoading || hasEmptyTemperature || !hasApiKey}
            onClick={() => Object.keys(DAY4_PROFILES).forEach(runProfile)}
            type="button"
          >
            {anyLoading ? "Запросы выполняются…" : "Запустить все параллельно"}
          </button>
        </div>
      </div>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Значения temperature">
        {Object.entries(DAY4_PROFILES).map(([id, item]) => (
          <button
            aria-controls="day4-temperature-panel"
            aria-selected={activeProfile === id}
            className={activeProfile === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveProfile(id)}
            role="tab"
            type="button"
          >
            {item.title}: {temperatures[id]} {loading[id] ? "…" : results[id] ? "✓" : ""}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day4-temperature-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{profile.title}</h3>
          <p className="muted">{PROFILE_DESCRIPTIONS[activeProfile]}</p>
        </div>

        <form
          className="temperature-form"
          onSubmit={(event) => {
            event.preventDefault();
            runProfile(activeProfile);
          }}
        >
          <label>
            Temperature
            <input
              disabled={loading[activeProfile]}
              max="2"
              min="0"
              onChange={(event) => updateTemperature(event.target.value)}
              step="0.1"
              type="number"
              value={temperatures[activeProfile]}
            />
          </label>
          <button
            className="primary-button"
            disabled={loading[activeProfile] || temperatures[activeProfile] === "" || !hasApiKey}
            type="submit"
          >
            {loading[activeProfile] ? "Ждём ответ…" : `Запустить temperature = ${temperatures[activeProfile]}`}
          </button>
        </form>

        {errors[activeProfile] && (
          <p className="error-message result-message">{errors[activeProfile]}</p>
        )}

        {result && (
          <section className="result-card" aria-live="polite">
            <div className="result-heading">
              <div>
                <p className="eyebrow">Ответ модели</p>
                <h3>{result.model}</h3>
              </div>
              <div className="result-actions">
                <span
                  className={`accuracy-badge ${
                    result.formatCorrect == null
                      ? "unknown"
                      : result.formatCorrect
                        ? "correct"
                        : "incorrect"
                  }`}
                >
                  {result.formatCorrect == null
                    ? "Без автопроверки"
                    : result.formatCorrect
                      ? "Формат соблюдён"
                      : "Формат нарушен"}
                </span>
                <button
                  className="secondary-button"
                  onClick={() =>
                    downloadResult(
                      activeProfile,
                      { prompt, model, maxTokens: Number(maxTokens), temperature: result.temperature },
                      result,
                    )
                  }
                  type="button"
                >
                  Скачать JSON
                </button>
              </div>
            </div>
            <div className="answer markdown-body">
              <MarkdownContent>
                {result.answer || "Модель не вернула текст. Попробуй увеличить лимит токенов."}
              </MarkdownContent>
            </div>
            <ResultMetrics result={result} />
            <p className="comparison-summary">
              Лексическое разнообразие: <strong>{result.lexicalDiversity}%</strong> уникальных слов.
            </p>
            <RequestDetails request={result.httpRequest} />
          </section>
        )}
      </section>

      {allReady && (
        <section className="result-card final-comparison" aria-live="polite">
          <p className="eyebrow">Итоговое сравнение</p>
          <div className="markdown-body">
            <MarkdownContent>{buildComparison(results)}</MarkdownContent>
          </div>
        </section>
      )}
    </section>
  );
}
