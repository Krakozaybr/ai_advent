import { useState } from "react";
import { DAY5_PROFILES, DEFAULT_DAY5_PROMPT } from "../shared/day5.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Выполните один и тот же запрос:

- 👉 на слабой модели
- 👉 на средней модели
- 👉 на сильной модели

Замерьте время ответа, количество токенов и стоимость.

Сравните качество ответов, скорость и ресурсоёмкость.

**Результат:** короткий вывод о различиях между моделями и ссылки.`;

const CHECK_LABELS = {
  code: "Есть блок JavaScript-кода",
  expectedResult: "Получен ожидаемый символ «к»",
  linearComplexity: "Указана сложность O(n)",
  unicode: "Учтён Unicode",
  nullFallback: "Предусмотрен возврат null",
};

const DEFAULT_MODELS = Object.fromEntries(
  Object.entries(DAY5_PROFILES).map(([id, profile]) => [id, profile.model]),
);
const EMPTY_RESULTS = { weak: null, medium: null, strong: null };
const EMPTY_ERRORS = { weak: "", medium: "", strong: "" };
const EMPTY_LOADING = { weak: false, medium: false, strong: false };

function bestProfile(results, metric, ids = Object.keys(results)) {
  return ids.reduce((bestId, id) =>
    metric(results[id]) < metric(results[bestId]) ? id : bestId,
  );
}

function buildComparison(results) {
  const rows = Object.entries(DAY5_PROFILES).map(([id, profile]) => {
    const result = results[id];
    const quality = result.qualityCheck
      ? `${result.qualityCheck.score}/${result.qualityCheck.total}`
      : "не проверяется";
    return `| ${profile.title} | [${profile.name}](${profile.url}) | ${profile.size} | ${quality} | ${result.usage?.total_tokens ?? "н/д"} | ${result.latencyMs} мс | $${Number(result.cost || 0).toFixed(6)} |`;
  });
  const fastest = bestProfile(results, (result) => result.latencyMs);
  const pricedProfiles = Object.keys(results).filter((id) => results[id].cost != null);
  const checkedProfiles = Object.keys(results).filter((id) => results[id].qualityCheck);
  const cheapest = pricedProfiles.length
    ? bestProfile(results, (result) => Number(result.cost), pricedProfiles)
    : null;
  const highestQuality = checkedProfiles.length
    ? bestProfile(results, (result) => -result.qualityCheck.score, checkedProfiles)
    : null;
  const qualityConclusion = highestQuality
    ? `Лучший результат по автоматическому чек-листу: **${DAY5_PROFILES[highestQuality].title.toLocaleLowerCase("ru-RU")} модель**.`
    : "Для изменённого prompt автоматическая проверка качества отключена.";
  const costConclusion = cheapest
    ? `Самая дешёвая в этом запуске: **${DAY5_PROFILES[cheapest].title.toLocaleLowerCase("ru-RU")}**.`
    : "OpenRouter не вернул стоимость этих запросов.";

  return `${qualityConclusion} Самая быстрая: **${DAY5_PROFILES[fastest].title.toLocaleLowerCase("ru-RU")}**. ${costConclusion}

| Уровень | Модель | Размер | Качество | Токенов | Время | Стоимость |
|---|---|---|---:|---:|---:|---:|
${rows.join("\n")}

> Это один короткий запуск через разных провайдеров OpenRouter. Он демонстрирует измерение, но не является полноценным бенчмарком моделей.`;
}

function downloadResult(id, settings, result) {
  const payload = { profile: id, settings, result };
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day5-${id}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Day5({ hasApiKey, onOpenSettings }) {
  const [activeProfile, setActiveProfile] = useState("weak");
  const [prompt, setPrompt] = useState(DEFAULT_DAY5_PROMPT);
  const [maxTokens, setMaxTokens] = useState(700);
  const [temperature, setTemperature] = useState(0);
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [errors, setErrors] = useState(EMPTY_ERRORS);
  const [loading, setLoading] = useState(EMPTY_LOADING);

  const profile = DAY5_PROFILES[activeProfile];
  const result = results[activeProfile];
  const anyLoading = Object.values(loading).some(Boolean);
  const allReady = Object.values(results).every(Boolean);

  function clearResults() {
    setResults(EMPTY_RESULTS);
    setErrors(EMPTY_ERRORS);
  }

  function updateShared(setter, value) {
    setter(value);
    clearResults();
  }

  function updateModel(value) {
    setModels((current) => ({ ...current, [activeProfile]: value }));
    setResults((current) => ({ ...current, [activeProfile]: null }));
    setErrors((current) => ({ ...current, [activeProfile]: "" }));
  }

  async function runProfile(id) {
    const settings = {
      prompt,
      model: models[id],
      maxTokens: Number(maxTokens),
      temperature: Number(temperature),
    };
    setLoading((current) => ({ ...current, [id]: true }));
    setResults((current) => ({ ...current, [id]: null }));
    setErrors((current) => ({ ...current, [id]: "" }));

    try {
      const nextResult = await apiRequest("/api/day5/run", {
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
    setPrompt(DEFAULT_DAY5_PROMPT);
    setMaxTokens(700);
    setTemperature(0);
    setModels(DEFAULT_MODELS);
    clearResults();
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 5</p>
          <h2>Версии моделей</h2>
          <p className="muted">Сравни три модели Qwen на одной проверяемой задаче.</p>
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
          Один prompt для всех моделей
          <textarea
            disabled={anyLoading}
            onChange={(event) => updateShared(setPrompt, event.target.value)}
            rows="9"
            value={prompt}
          />
        </label>
        <div className="day5-common-settings">
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
          <label>
            Temperature
            <input
              disabled={anyLoading}
              max="2"
              min="0"
              onChange={(event) => updateShared(setTemperature, event.target.value)}
              step="0.1"
              type="number"
              value={temperature}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled={anyLoading} onClick={resetAll} type="button">
            Сбросить всё
          </button>
          <button
            className="primary-button"
            disabled={anyLoading || temperature === "" || !hasApiKey}
            onClick={() => Object.keys(DAY5_PROFILES).forEach(runProfile)}
            type="button"
          >
            {anyLoading ? "Модели отвечают…" : "Запустить все параллельно"}
          </button>
        </div>
      </div>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Уровни моделей">
        {Object.entries(DAY5_PROFILES).map(([id, item]) => (
          <button
            aria-controls="day5-model-panel"
            aria-selected={activeProfile === id}
            className={activeProfile === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveProfile(id)}
            role="tab"
            type="button"
          >
            {item.title} {loading[id] ? "…" : results[id] ? "✓" : ""}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day5-model-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{profile.title}: {profile.name}</h3>
          <p className="muted">
            {profile.size}. {" "}
            <a href={profile.url} rel="noreferrer" target="_blank">
              Страница модели в OpenRouter
            </a>
          </p>
        </div>

        <form
          className="single-run-form"
          onSubmit={(event) => {
            event.preventDefault();
            runProfile(activeProfile);
          }}
        >
          <label>
            ID модели OpenRouter
            <input
              disabled={loading[activeProfile]}
              onChange={(event) => updateModel(event.target.value)}
              value={models[activeProfile]}
            />
          </label>
          <button
            className="primary-button"
            disabled={loading[activeProfile] || temperature === "" || !hasApiKey}
            type="submit"
          >
            {loading[activeProfile] ? "Ждём ответ…" : `Запустить: ${profile.title}`}
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
                    !result.qualityCheck
                      ? "unknown"
                      : result.qualityCheck.score === result.qualityCheck.total
                        ? "correct"
                        : "incorrect"
                  }`}
                >
                  {result.qualityCheck
                    ? `Чек-лист ${result.qualityCheck.score}/${result.qualityCheck.total}`
                    : "Без автопроверки"}
                </span>
                <button
                  className="secondary-button"
                  onClick={() =>
                    downloadResult(
                      activeProfile,
                      {
                        prompt,
                        model: models[activeProfile],
                        maxTokens: Number(maxTokens),
                        temperature: Number(temperature),
                      },
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
            {result.qualityCheck && (
              <details className="quality-details">
                <summary>Как рассчитано качество</summary>
                <ul>
                  {Object.entries(CHECK_LABELS).map(([id, label]) => (
                    <li key={id}>
                      {result.qualityCheck.checks[id] ? "✅" : "❌"} {label}
                    </li>
                  ))}
                </ul>
              </details>
            )}
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
