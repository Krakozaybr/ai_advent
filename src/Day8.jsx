import { useState } from "react";
import { DEFAULT_DAY7_SYSTEM_PROMPT } from "../shared/day7.js";
import {
  buildDay8HistoryPreview,
  DAY8_SCENARIOS,
  DEFAULT_DAY8_CONTEXT_LIMIT,
  DEFAULT_DAY8_PROMPT,
} from "../shared/day8.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Добавьте в код агента подсчёт токенов:

- 👉 для текущего запроса
- 👉 для всей истории диалога
- 👉 для ответа модели

Сравните короткий диалог, длинный диалог и диалог, который превышает лимит модели.

Покажите, как растут стоимость и токены по мере диалога, а также что ломается при переполнении.

**Результат:** код считает токены и показывает, как они влияют на поведение агента.`;

const EMPTY_RESULTS = { short: null, long: null, overflow: null };
const EMPTY_ERRORS = { short: "", long: "", overflow: "" };
const EMPTY_LOADING = { short: false, long: false, overflow: false };

function formatTokenCount(value) {
  return value == null ? "н/д" : value.toLocaleString("ru-RU");
}

function buildComparison(results) {
  const rows = Object.entries(DAY8_SCENARIOS).map(([id, scenario]) => {
    const result = results[id];
    const counts = result.tokenCounts;
    const status = result.failed
      ? "ошибка OpenRouter"
      : result.exceedsLimit
        ? "ответ получен сверх оценки"
        : "получен ответ";
    const cost = result.cost == null ? "н/д" : `$${Number(result.cost).toFixed(6)}`;
    return `| ${scenario.title} | ${result.historyMessages} | ≈ ${counts.estimatedCurrentMessage} | ≈ ${counts.estimatedHistory} | ${counts.actualInput ?? "—"} | ${counts.actualResponse ?? "—"} | ${counts.actualTotal ?? "—"} | ${cost} | ${status} |`;
  });
  const shortInput = results.short.tokenCounts.actualInput;
  const longInput = results.long.tokenCounts.actualInput;
  const growth = shortInput != null && longInput != null
    ? `Фактический вход вырос с **${shortInput}** до **${longInput} токенов**.`
    : "Длинная история увеличила оценку входного контекста.";

  return `${growth} Вместе с контекстом обычно растёт и стоимость запроса. Переполненный сценарий тоже отправлен в OpenRouter, поэтому в таблице виден реальный результат провайдера.

| Сценарий | Сообщений в истории | Текущий запрос | История | Вход API | Ответ | Всего | Стоимость | Результат |
|---|---:|---:|---:|---:|---:|---:|---:|---|
${rows.join("\n")}

> Значения со знаком ≈ — локальная оценка до отправки. Точные значения без знака возвращены OpenRouter после ответа.`;
}

function downloadResult(id, result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day8-${id}-tokens.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Day8({ hasApiKey, onOpenSettings }) {
  const [activeScenario, setActiveScenario] = useState("short");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY7_SYSTEM_PROMPT);
  const [prompt, setPrompt] = useState(DEFAULT_DAY8_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(180);
  const [contextLimit, setContextLimit] = useState(DEFAULT_DAY8_CONTEXT_LIMIT);
  const [temperature, setTemperature] = useState(0.2);
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [errors, setErrors] = useState(EMPTY_ERRORS);
  const [loading, setLoading] = useState(EMPTY_LOADING);

  const scenario = DAY8_SCENARIOS[activeScenario];
  const result = results[activeScenario];
  const historyPreview = buildDay8HistoryPreview(activeScenario);
  const historyCharacters = historyPreview.reduce((total, item) => total + item.fullLength, 0);
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

  async function runScenario(id) {
    setLoading((current) => ({ ...current, [id]: true }));
    setResults((current) => ({ ...current, [id]: null }));
    setErrors((current) => ({ ...current, [id]: "" }));

    try {
      const nextResult = await apiRequest("/api/day8/run", {
        method: "POST",
        body: JSON.stringify({
          scenario: id,
          systemPrompt,
          prompt,
          model,
          maxTokens: Number(maxTokens),
          contextLimit: Number(contextLimit),
          temperature: Number(temperature),
        }),
      });
      setResults((current) => ({ ...current, [id]: nextResult }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [id]: requestError.message }));
    } finally {
      setLoading((current) => ({ ...current, [id]: false }));
    }
  }

  function resetAll() {
    setSystemPrompt(DEFAULT_DAY7_SYSTEM_PROMPT);
    setPrompt(DEFAULT_DAY8_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(180);
    setContextLimit(DEFAULT_DAY8_CONTEXT_LIMIT);
    setTemperature(0.2);
    clearResults();
  }

  const limitUsed = result
    ? Math.min(100, Math.round((result.tokenCounts.estimatedWithResponse / contextLimit) * 100))
    : 0;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 8</p>
          <h2>Работа с токенами</h2>
          <p className="muted">Сравни размер контекста, ответ, стоимость и переполнение.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Для короткого и длинного сценариев нужен ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">
            Открыть настройки
          </button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture">
        <summary>Как считается и что произойдёт при переполнении</summary>
        <p>
          До API приложение оценивает токены по размеру UTF-8-текста и добавляет служебные
          токены сообщений. Точное разбиение зависит от токенизатора выбранной модели,
          поэтому после ответа показываются фактические счётчики OpenRouter.
        </p>
        <p>
          Для дефолтной Qwen-модели указан лимит <strong>262 144</strong> токена.
          Переполненный сценарий создаёт ещё более крупную историю и действительно отправляет
          её в OpenRouter, чтобы показать ответ или ошибку провайдера. Значение можно изменить.
        </p>
      </details>

      <div className="notice">
        Сценарий «Переполнение» действительно отправляет большой контекст: локальная оценка
        около 376 000 токенов. Возможны списание примерно $0.015, ошибка провайдера или таймаут.
      </div>

      <div className="experiment-form shared-task">
        <label>
          Системная инструкция агента
          <textarea
            disabled={anyLoading}
            onChange={(event) => updateShared(setSystemPrompt, event.target.value)}
            rows="4"
            value={systemPrompt}
          />
        </label>
        <div className="day8-settings-grid">
          <label>
            Модель OpenRouter
            <input
              disabled={anyLoading}
              onChange={(event) => updateShared(setModel, event.target.value)}
              value={model}
            />
          </label>
          <label>
            Резерв ответа
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
            Контекстное окно модели
            <input
              disabled={anyLoading}
              max="1000000"
              min="256"
              onChange={(event) => updateShared(setContextLimit, event.target.value)}
              type="number"
              value={contextLimit}
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
            disabled={anyLoading || !hasApiKey || temperature === ""}
            onClick={() => Object.keys(DAY8_SCENARIOS).forEach(runScenario)}
            type="button"
          >
            {anyLoading ? "Сценарии выполняются…" : "Запустить все сценарии"}
          </button>
        </div>
      </div>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Размеры диалога">
        {Object.entries(DAY8_SCENARIOS).map(([id, item]) => (
          <button
            aria-controls="day8-scenario-panel"
            aria-selected={activeScenario === id}
            className={activeScenario === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveScenario(id)}
            role="tab"
            type="button"
          >
            {item.title} {loading[id] ? "…" : results[id] ? "✓" : ""}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day8-scenario-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{scenario.title}</h3>
          <p className="muted">
            {scenario.description} В истории {historyPreview.length} сообщений и {formatTokenCount(historyCharacters)} символов.
          </p>
        </div>

        <section className="chat-shell day8-chat" aria-label={`Сообщения сценария: ${scenario.title}`}>
          <div className="chat-list" aria-live="polite">
            <div className="chat-message system-message">
              <span className="chat-role">System</span>
              <p>{systemPrompt}</p>
            </div>

            {historyPreview.map((item, index) => (
              <div
                className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}
                key={`${activeScenario}-${index}`}
              >
                <span className="chat-role">{item.role === "user" ? "User" : "Assistant"}</span>
                <p>{item.content}</p>
                {item.repetitions > 1 && (
                  <span className="chat-preview-note">
                    В API: этот текст × {item.repetitions} · {formatTokenCount(item.fullLength)} символов
                  </span>
                )}
              </div>
            ))}

            <div className="chat-message user-message current-request-message">
              <span className="chat-role">Текущий User-запрос</span>
              <p>{prompt || "Пустой запрос"}</p>
            </div>

            {loading[activeScenario] && (
              <div className="chat-message assistant-message">
                <span className="chat-role">Assistant</span>
                <p className="muted">OpenRouter обрабатывает весь показанный контекст…</p>
              </div>
            )}

            {errors[activeScenario] && (
              <div className="chat-message assistant-message">
                <span className="chat-role">Ошибка приложения</span>
                <p className="error-message">{errors[activeScenario]}</p>
              </div>
            )}

            {result && (
              <div className="chat-message assistant-message">
                <span className="chat-role">{result.failed ? "Ошибка OpenRouter" : "Assistant"}</span>
                {result.failed ? (
                  <p className="error-message">{result.reason}</p>
                ) : (
                  <div className="markdown-body">
                    <MarkdownContent>{result.answer || "Модель не вернула текст."}</MarkdownContent>
                  </div>
                )}
              </div>
            )}
          </div>

          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              runScenario(activeScenario);
            }}
          >
            <label>
              Текущий запрос для всех сценариев
              <textarea
                disabled={anyLoading}
                onChange={(event) => updateShared(setPrompt, event.target.value)}
                rows="4"
                value={prompt}
              />
            </label>
            <div className="button-row">
              <span className="field-hint">Отправятся system + история выше + этот запрос.</span>
              <button
                className="primary-button"
                disabled={loading[activeScenario] || !hasApiKey || !prompt.trim() || temperature === ""}
                type="submit"
              >
                {loading[activeScenario] ? "Отправляется…" : `Отправить: ${scenario.title}`}
              </button>
            </div>
          </form>
        </section>

        {result && (
          <section className={`result-card ${result.exceedsLimit ? "overflow-result" : ""}`} aria-live="polite">
            <div className="result-heading">
              <div>
                <p className="eyebrow">Результат сценария</p>
                <h3>{result.failed ? "OpenRouter вернул ошибку" : result.model}</h3>
              </div>
              <div className="result-actions">
                <span
                  className={`accuracy-badge ${
                    result.failed ? "incorrect" : result.exceedsLimit ? "unknown" : "correct"
                  }`}
                >
                  {result.failed
                    ? "Ошибка после отправки"
                    : result.exceedsLimit
                      ? "Отправлено сверх лимита"
                      : "Ответ получен"}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => downloadResult(activeScenario, result)}
                  type="button"
                >
                  Скачать JSON
                </button>
              </div>
            </div>

            <div className="context-meter" aria-label={`Использовано ${limitUsed}% контекстного окна`}>
              <span style={{ width: `${limitUsed}%` }} />
            </div>
            <p className="field-hint">
              Оценка входа и резерва ответа: {formatTokenCount(result.tokenCounts.estimatedWithResponse)} из {formatTokenCount(result.tokenCounts.contextLimit)} токенов.
            </p>

            <div className="token-grid">
              <div><span>Текущий запрос</span><strong>≈ {formatTokenCount(result.tokenCounts.estimatedCurrentMessage)}</strong></div>
              <div><span>Вся история</span><strong>≈ {formatTokenCount(result.tokenCounts.estimatedHistory)}</strong></div>
              <div><span>Весь вход</span><strong>≈ {formatTokenCount(result.tokenCounts.estimatedInput)}</strong></div>
              <div><span>Ответ модели</span><strong>{formatTokenCount(result.tokenCounts.actualResponse)}</strong></div>
            </div>

            {!result.failed && (
              <>
                <ResultMetrics result={result} />
                <p className="comparison-summary">
                  OpenRouter насчитал во входе <strong>{formatTokenCount(result.tokenCounts.actualInput)}</strong>,
                  в ответе <strong>{formatTokenCount(result.tokenCounts.actualResponse)}</strong> токенов.
                </p>
              </>
            )}
            <RequestDetails
              request={result.httpRequest}
              title={result.failed ? "Технические детали отправленного запроса" : undefined}
            />
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
