import { useState } from "react";
import Markdown from "react-markdown";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const DEFAULT_PROMPT = "Объясни простыми словами, что такое большая языковая модель.";
const DEFAULT_MAX_TOKENS = 300;
const ASSIGNMENT = `Напишите минимальный код, который:

- 👉 отправляет запрос в LLM через API
- 👉 получает ответ
- 👉 выводит его в консоль или простой интерфейс (CLI / Web)

**Результат:** код, который отправляет запрос в LLM через API и получает ответ.`;

export function Day1({ hasApiKey, onOpenSettings }) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function runExperiment(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const nextResult = await apiRequest("/api/day1/run", {
        method: "POST",
        body: JSON.stringify({ prompt, model, maxTokens: Number(maxTokens) }),
      });
      setResult(nextResult);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPrompt(DEFAULT_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(DEFAULT_MAX_TOKENS);
    setResult(null);
    setError("");
  }

  function downloadResult() {
    const payload = { request: { prompt, model, maxTokens: Number(maxTokens) }, response: result };
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "day1-result.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 1</p>
          <h2>Первый запрос к LLM</h2>
          <p className="muted">Отправь текст через OpenRouter и получи ответ модели.</p>
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
          Запрос
          <textarea
            onChange={(event) => setPrompt(event.target.value)}
            rows="5"
            value={prompt}
          />
        </label>
        <div className="field-grid">
          <label>
            Модель OpenRouter
            <input onChange={(event) => setModel(event.target.value)} value={model} />
          </label>
          <label>
            Максимум токенов ответа
            <input
              max="8192"
              min="1"
              onChange={(event) => setMaxTokens(event.target.value)}
              type="number"
              value={maxTokens}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="secondary-button" onClick={reset} type="button">
            Сбросить
          </button>
          <button className="primary-button" disabled={loading || !hasApiKey} type="submit">
            {loading ? "Ждём модель…" : "Отправить запрос"}
          </button>
        </div>
      </form>

      {error && <p className="error-message result-message">{error}</p>}

      {result && (
        <section className="result-card" aria-live="polite">
          <div className="result-heading">
            <div>
              <p className="eyebrow">Ответ модели</p>
              <h3>{result.model}</h3>
            </div>
            <button className="secondary-button" onClick={downloadResult} type="button">
              Скачать JSON
            </button>
          </div>
          <div className="answer markdown-body">
            <Markdown>
              {result.answer ||
                "Модель не вернула текст. Попробуй увеличить лимит токенов ответа."}
            </Markdown>
          </div>
          <ResultMetrics result={result} />
          <details>
            <summary>Технические детали</summary>
            <pre>{JSON.stringify({ request: { model, maxTokens }, usage: result.usage }, null, 2)}</pre>
          </details>
        </section>
      )}
    </section>
  );
}
