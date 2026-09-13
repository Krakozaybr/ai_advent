import { useState } from "react";
import Markdown from "react-markdown";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Отправьте один и тот же запрос, но:

- 👉 добавьте явное описание формата ответа
- 👉 добавьте ограничение на длину ответа
- 👉 добавьте условие завершения ответа (stop sequence или явную инструкцию)

Сравните ответы:

- 👉 без ограничений
- 👉 с ограничениями

**Результат:** один и тот же запрос с разным уровнем контроля ответа через API.`;

const DEFAULT_FORMS = {
  free: {
    model: DEFAULT_MODEL,
    prompt: "Объясни разницу между let и const в JavaScript.",
  },
  controlled: {
    model: DEFAULT_MODEL,
    prompt: `Объясни разницу между let и const в JavaScript.

Формат ответа: Markdown-заголовок и два пункта — отдельно про let и const.
Длина: не более 80 слов.
Завершение: в конце отдельной строкой напиши END.`,
    maxTokens: 220,
    stop: "END",
  },
};

const VARIANTS = {
  free: {
    title: "Без ограничений",
    description: "Модель получает только исходный вопрос — без формата, лимита и stop sequence.",
  },
  controlled: {
    title: "С ограничениями",
    description: "Prompt явно задаёт формат, длину и завершение; API дополнительно передаёт лимит и stop.",
  },
};

function downloadResult(variant, result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day2-${variant}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Day2({ hasApiKey, onOpenSettings }) {
  const [activeVariant, setActiveVariant] = useState("free");
  const [forms, setForms] = useState(DEFAULT_FORMS);
  const [results, setResults] = useState({ free: null, controlled: null });
  const [errors, setErrors] = useState({ free: "", controlled: "" });
  const [loadingVariant, setLoadingVariant] = useState(null);

  const form = forms[activeVariant];
  const result = results[activeVariant];
  const variant = VARIANTS[activeVariant];

  function update(name, value) {
    setForms((current) => ({
      ...current,
      [activeVariant]: { ...current[activeVariant], [name]: value },
    }));
  }

  async function runExperiment(event) {
    event.preventDefault();
    const requestedVariant = activeVariant;
    const requestedForm = forms[requestedVariant];
    setLoadingVariant(requestedVariant);
    setErrors((current) => ({ ...current, [requestedVariant]: "" }));

    try {
      const nextResult = await apiRequest("/api/day2/run", {
        method: "POST",
        body: JSON.stringify({
          ...requestedForm,
          variant: requestedVariant,
          maxTokens:
            requestedVariant === "controlled" ? Number(requestedForm.maxTokens) : undefined,
        }),
      });
      setResults((current) => ({ ...current, [requestedVariant]: nextResult }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [requestedVariant]: requestError.message }));
    } finally {
      setLoadingVariant(null);
    }
  }

  function resetActiveVariant() {
    setForms((current) => ({ ...current, [activeVariant]: DEFAULT_FORMS[activeVariant] }));
    setResults((current) => ({ ...current, [activeVariant]: null }));
    setErrors((current) => ({ ...current, [activeVariant]: "" }));
  }

  const bothReady = results.free && results.controlled;
  const wordDifference = bothReady
    ? results.free.response.wordCount - results.controlled.response.wordCount
    : 0;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 2</p>
          <h2>Контроль формата ответа</h2>
          <p className="muted">Запусти два варианта отдельно, затем сравни результаты.</p>
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

      <div className="variant-tabs" role="tablist" aria-label="Варианты эксперимента">
        {Object.entries(VARIANTS).map(([id, item]) => (
          <button
            aria-controls="day2-variant-panel"
            aria-selected={activeVariant === id}
            className={activeVariant === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveVariant(id)}
            role="tab"
            type="button"
          >
            {item.title} {results[id] ? "✓" : ""}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day2-variant-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{variant.title}</h3>
          <p className="muted">{variant.description}</p>
        </div>

        <form className="experiment-form" onSubmit={runExperiment}>
          <label>
            Prompt
            <textarea
              onChange={(event) => update("prompt", event.target.value)}
              rows={activeVariant === "controlled" ? 8 : 4}
              value={form.prompt}
            />
          </label>
          <div className="field-grid">
            <label>
              Модель OpenRouter
              <input onChange={(event) => update("model", event.target.value)} value={form.model} />
            </label>
            {activeVariant === "controlled" && (
              <div className="compact-fields">
                <label>
                  Максимум токенов
                  <input
                    max="8192"
                    min="1"
                    onChange={(event) => update("maxTokens", event.target.value)}
                    type="number"
                    value={form.maxTokens}
                  />
                </label>
                <label>
                  Stop sequence
                  <input onChange={(event) => update("stop", event.target.value)} value={form.stop} />
                </label>
              </div>
            )}
          </div>
          {activeVariant === "controlled" && (
            <p className="field-hint">
              Stop sequence не показывается в ответе: OpenRouter завершает генерацию прямо перед ней.
            </p>
          )}
          <div className="button-row">
            <button className="secondary-button" onClick={resetActiveVariant} type="button">
              Сбросить вариант
            </button>
            <button
              className="primary-button"
              disabled={loadingVariant !== null || !hasApiKey}
              type="submit"
            >
              {loadingVariant === activeVariant ? "Ждём ответ…" : `Отправить: ${variant.title}`}
            </button>
          </div>
        </form>

        {errors[activeVariant] && (
          <p className="error-message result-message">{errors[activeVariant]}</p>
        )}

        {result && (
          <section className="result-card" aria-live="polite">
            <div className="result-heading">
              <div>
                <p className="eyebrow">Ответ модели</p>
                <h3>{result.response.model}</h3>
              </div>
              <button
                className="secondary-button"
                onClick={() => downloadResult(activeVariant, result)}
                type="button"
              >
                Скачать JSON
              </button>
            </div>
            <div className="answer markdown-body">
              <Markdown>
                {result.response.answer ||
                  "Модель не вернула текст. Попробуй увеличить лимит токенов."}
              </Markdown>
            </div>
            <ResultMetrics result={result.response} />
            <details>
              <summary>Технические детали запроса</summary>
              <pre>{JSON.stringify(result.request, null, 2)}</pre>
            </details>
          </section>
        )}
      </section>

      {bothReady && (
        <p className="comparison-summary final-comparison">
          Оба варианта готовы. Ответ с ограничениями {wordDifference >= 0 ? "короче" : "длиннее"}
          {" на "}
          <strong>{Math.abs(wordDifference)}</strong> слов.
        </p>
      )}
    </section>
  );
}
