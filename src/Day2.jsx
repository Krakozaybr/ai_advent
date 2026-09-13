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
const DEFAULTS = {
  prompt: "Объясни разницу между let и const в JavaScript.",
  model: DEFAULT_MODEL,
  format: "Markdown: заголовок и два пункта — отдельно про let и const.",
  maxWords: 80,
  maxTokens: 220,
  stop: "END",
};

function ComparisonCard({ result }) {
  return (
    <article className="comparison-card">
      <div className="answer markdown-body">
        <Markdown>
          {result.answer || "Модель не вернула текст. Попробуй увеличить лимит токенов."}
        </Markdown>
      </div>
      <ResultMetrics result={result} />
    </article>
  );
}

export function Day2({ hasApiKey, onOpenSettings }) {
  const [form, setForm] = useState(DEFAULTS);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeVariant, setActiveVariant] = useState("withoutConstraints");

  function update(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function runExperiment(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    setActiveVariant("withoutConstraints");

    try {
      const nextResult = await apiRequest("/api/day2/run", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          maxWords: Number(form.maxWords),
          maxTokens: Number(form.maxTokens),
        }),
      });
      setResult(nextResult);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setForm(DEFAULTS);
    setResult(null);
    setError("");
    setActiveVariant("withoutConstraints");
  }

  function downloadResult() {
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "day2-result.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  const wordDifference = result
    ? result.withoutConstraints.wordCount - result.withConstraints.wordCount
    : 0;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 2</p>
          <h2>Контроль формата ответа</h2>
          <p className="muted">Сравни один запрос без ограничений и с явными правилами.</p>
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

      <form className="experiment-form" onSubmit={runExperiment}>
        <label>
          Один запрос для обоих вариантов
          <textarea
            onChange={(event) => update("prompt", event.target.value)}
            rows="4"
            value={form.prompt}
          />
        </label>
        <label>
          Явное описание формата
          <textarea
            onChange={(event) => update("format", event.target.value)}
            rows="3"
            value={form.format}
          />
        </label>
        <div className="field-grid day2-fields">
          <label>
            Модель OpenRouter
            <input onChange={(event) => update("model", event.target.value)} value={form.model} />
          </label>
          <label>
            Максимум слов
            <input
              max="500"
              min="1"
              onChange={(event) => update("maxWords", event.target.value)}
              type="number"
              value={form.maxWords}
            />
          </label>
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
            <span className="field-hint">OpenRouter остановится перед этой строкой.</span>
          </label>
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={reset} type="button">
            Сбросить
          </button>
          <button className="primary-button" disabled={loading || !hasApiKey} type="submit">
            {loading ? "Ждём два ответа…" : "Сравнить ответы"}
          </button>
        </div>
      </form>

      {error && <p className="error-message result-message">{error}</p>}

      {result && (
        <section className="result-card" aria-live="polite">
          <div className="result-heading">
            <div>
              <p className="eyebrow">Сравнение</p>
              <h3>{result.request.model}</h3>
            </div>
            <button className="secondary-button" onClick={downloadResult} type="button">
              Скачать JSON
            </button>
          </div>
          <p className="comparison-summary">
            Управляемый ответ {wordDifference >= 0 ? "короче" : "длиннее"} на{" "}
            <strong>{Math.abs(wordDifference)}</strong> слов.
          </p>
          <div className="variant-tabs" role="tablist" aria-label="Варианты ответа">
            <button
              aria-controls="day2-variant-panel"
              aria-selected={activeVariant === "withoutConstraints"}
              className={
                activeVariant === "withoutConstraints" ? "variant-tab active" : "variant-tab"
              }
              onClick={() => setActiveVariant("withoutConstraints")}
              role="tab"
              type="button"
            >
              Без ограничений · {result.withoutConstraints.wordCount} слов
            </button>
            <button
              aria-controls="day2-variant-panel"
              aria-selected={activeVariant === "withConstraints"}
              className={
                activeVariant === "withConstraints" ? "variant-tab active" : "variant-tab"
              }
              onClick={() => setActiveVariant("withConstraints")}
              role="tab"
              type="button"
            >
              С ограничениями · {result.withConstraints.wordCount} слов
            </button>
          </div>
          <div id="day2-variant-panel" role="tabpanel">
            <ComparisonCard result={result[activeVariant]} />
          </div>
          <details>
            <summary>Технические детали и управляемый prompt</summary>
            <pre>{JSON.stringify(result.request, null, 2)}</pre>
          </details>
        </section>
      )}
    </section>
  );
}
