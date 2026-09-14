import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_DAY7_SYSTEM_PROMPT } from "../shared/day7.js";
import {
  DAY8_SCENARIOS,
  DEFAULT_DAY8_CONTEXT_LIMIT,
  getDay8ScriptPrompt,
} from "../shared/day8.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { estimateMessagesTokens, estimateTextTokens } from "../shared/token-counter.js";
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

const SCENARIO_IDS = Object.keys(DAY8_SCENARIOS);

function emptyScenarioState(value) {
  return Object.fromEntries(SCENARIO_IDS.map((id) => [id, value]));
}

function initialDrafts() {
  return Object.fromEntries(SCENARIO_IDS.map((id) => [id, getDay8ScriptPrompt(id, 0)]));
}

function formatTokenCount(value) {
  return value == null ? "н/д" : value.toLocaleString("ru-RU");
}

function buildComparison(results) {
  const rows = Object.entries(DAY8_SCENARIOS).map(([id, scenario]) => {
    const result = results[id];
    const counts = result.tokenCounts;
    const status = result.failed
      ? "ошибка OpenRouter"
      : result.compressionEnabled
        ? "ответ после сжатия"
        : "получен ответ";
    const cost = result.cost == null ? "н/д" : `$${Number(result.cost).toFixed(6)}`;
    return `| ${scenario.title} | ${result.historyMessages} | ≈ ${counts.estimatedCurrentMessage} | ≈ ${counts.estimatedHistory} | ${counts.actualInput ?? "—"} | ${counts.actualResponse ?? "—"} | ${cost} | ${status} |`;
  });

  return `Значения со знаком ≈ — локальная оценка до отправки. Точные значения возвращает OpenRouter после успешного ответа.

| Сценарий | Сообщений в истории | Текущий запрос | История | Вход API | Ответ | Стоимость | Результат |
|---|---:|---:|---:|---:|---:|---:|---|
${rows.join("\n")}`;
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

function ChatMessage({ item }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = item.content.length > 1_200;
  const preview = isLong ? `${item.content.slice(0, 900)}\n…` : item.content;
  const roleLabel =
    item.role === "user" ? "User" : item.role === "error" ? "Ошибка OpenRouter" : "Assistant";
  const messageClass = item.role === "user" ? "user-message" : "assistant-message";

  return (
    <div className={`chat-message ${messageClass}`}>
      <span className="chat-role">{roleLabel}</span>
      {item.role === "assistant" ? (
        <div className="markdown-body">
          <MarkdownContent>{item.content}</MarkdownContent>
        </div>
      ) : (
        <p className={item.role === "error" ? "error-message" : undefined}>{preview}</p>
      )}
      {isLong && (
        <>
          <span className="chat-preview-note">
            {formatTokenCount(item.content.length)} символов · показано начало
          </span>
          <details
            className="chat-message-expander"
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary>{expanded ? "Скрыть полный текст" : "Показать весь текст"}</summary>
            {expanded && <div className="chat-full-content">{item.content}</div>}
          </details>
        </>
      )}
    </div>
  );
}

export function Day8({ hasApiKey, onOpenSettings }) {
  const [activeScenario, setActiveScenario] = useState("short");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY7_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(180);
  const [contextLimit, setContextLimit] = useState(DEFAULT_DAY8_CONTEXT_LIMIT);
  const [temperature, setTemperature] = useState(0.2);
  const [messagesByScenario, setMessagesByScenario] = useState(() =>
    emptyScenarioState(null),
  );
  const [drafts, setDrafts] = useState(initialDrafts);
  const [results, setResults] = useState(() => emptyScenarioState(null));
  const [loading, setLoading] = useState(() => emptyScenarioState(false));
  const chatEndRef = useRef(null);

  const messages = messagesByScenario[activeScenario] ?? [];
  const draft = drafts[activeScenario] ?? "";
  const scenario = DAY8_SCENARIOS[activeScenario];
  const result = results[activeScenario];
  const anyLoading = Object.values(loading).some(Boolean);
  const allReady = Object.values(results).every(Boolean);

  const tokenCounts = useMemo(() => {
    const history = messages.filter((item) => item.role === "user" || item.role === "assistant");
    const requestMessages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: draft },
    ];
    const estimatedHistory = history.length ? estimateMessagesTokens(history) : 0;
    const estimatedInput = estimateMessagesTokens(requestMessages);

    return {
      current: estimateTextTokens(draft),
      history: estimatedHistory,
      input: estimatedInput,
      withResponse: estimatedInput + Number(maxTokens || 0),
    };
  }, [draft, maxTokens, messages, systemPrompt]);

  const exceedsLimit = tokenCounts.withResponse > Number(contextLimit);
  const limitUsed = Number(contextLimit)
    ? Math.min(100, Math.round((tokenCounts.withResponse / Number(contextLimit)) * 100))
    : 0;
  const canSend = Boolean(
    !loading[activeScenario] &&
      hasApiKey &&
      draft.trim() &&
      model.trim() &&
      temperature !== "",
  );

  useEffect(() => {
    if (messages.length === 0 && !loading[activeScenario]) {
      return undefined;
    }

    const animationFrame = requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [activeScenario, loading, messages.length]);

  function updateDraft(value) {
    setDrafts((current) => ({ ...current, [activeScenario]: value }));
  }

  function resetSettings() {
    setSystemPrompt(DEFAULT_DAY7_SYSTEM_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(180);
    setContextLimit(DEFAULT_DAY8_CONTEXT_LIMIT);
    setTemperature(0.2);
  }

  function clearAllHistory() {
    setMessagesByScenario(emptyScenarioState(null));
    setDrafts(initialDrafts());
    setResults(emptyScenarioState(null));
    setLoading(emptyScenarioState(false));
  }

  async function runScenario(id) {
    const prompt = drafts[id]?.trim();
    if (!prompt || loading[id]) {
      return;
    }

    const previousMessages = messagesByScenario[id] ?? [];
    const history = previousMessages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map(({ role, content }) => ({ role, content }));

    setLoading((current) => ({ ...current, [id]: true }));
    setResults((current) => ({ ...current, [id]: null }));
    setMessagesByScenario((current) => ({
      ...current,
      [id]: [...(current[id] ?? []), { role: "user", content: prompt }],
    }));

    try {
      const nextResult = await apiRequest("/api/day8/run", {
        method: "POST",
        body: JSON.stringify({
          scenario: id,
          history,
          systemPrompt,
          prompt,
          model,
          maxTokens: Number(maxTokens),
          contextLimit: Number(contextLimit),
          temperature: Number(temperature),
        }),
      });

      setResults((current) => ({ ...current, [id]: nextResult }));
      if (nextResult.failed) {
        setMessagesByScenario((current) => ({
          ...current,
          [id]: [
            ...(current[id] ?? []),
            {
              role: "error",
              content: `LLM не сформировала ответ. Запрос отправлен, но генерация не началась: ${nextResult.reason}`,
            },
          ],
        }));
        return;
      }

      setMessagesByScenario((current) => ({
        ...current,
        [id]: [
          ...(current[id] ?? []),
          { role: "assistant", content: nextResult.answer || "Модель не вернула текст." },
        ],
      }));
      const completedUserMessages = history.filter((item) => item.role === "user").length + 1;
      setDrafts((current) => ({
        ...current,
        [id]: getDay8ScriptPrompt(id, completedUserMessages),
      }));
    } catch (requestError) {
      setMessagesByScenario((current) => ({
        ...current,
        [id]: [
          ...(current[id] ?? []),
          { role: "error", content: `Запрос завершился ошибкой: ${requestError.message}` },
        ],
      }));
    } finally {
      setLoading((current) => ({ ...current, [id]: false }));
    }
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 8</p>
          <h2>Работа с токенами</h2>
          <p className="muted">Проведи три диалога и наблюдай рост контекста до отправки.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Для запросов нужен ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">
            Открыть настройки
          </button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture">
        <summary>Как считается и что произойдёт при переполнении</summary>
        <p>
          До API приложение приблизительно считает токены по размеру UTF-8-текста. После
          успешного ответа рядом появляются точные значения OpenRouter.
        </p>
        <p>
          В сценарии переполнения сначала отправляется короткий факт. Затем в поле ввода
          подставляется вопрос с большим stack trace. В OpenRouter отправляется полный текст,
          после чего плагин context-compression удаляет часть середины, чтобы запрос поместился
          в окно модели.
        </p>
      </details>

      <div className="notice">
        Для сценария «Переполнение» включён OpenRouter context-compression. Большой stack trace
        создаётся после ответа на первое сообщение; перед второй отправкой индикатор покажет
        исходный размер запроса и превышение лимита.
      </div>

      <div className="experiment-form shared-task">
        <label>
          Системная инструкция агента
          <textarea
            disabled={anyLoading}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows="4"
            value={systemPrompt}
          />
        </label>
        <div className="day8-settings-grid">
          <label>
            Модель OpenRouter
            <input
              disabled={anyLoading}
              onChange={(event) => setModel(event.target.value)}
              value={model}
            />
          </label>
          <label>
            Резерв ответа
            <input
              disabled={anyLoading}
              max="8192"
              min="1"
              onChange={(event) => setMaxTokens(event.target.value)}
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
              onChange={(event) => setContextLimit(event.target.value)}
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
              onChange={(event) => setTemperature(event.target.value)}
              step="0.1"
              type="number"
              value={temperature}
            />
          </label>
        </div>
        <div className="button-row memory-actions">
          <button className="secondary-button" disabled={anyLoading} onClick={resetSettings} type="button">
            Сбросить настройки
          </button>
          <button className="secondary-button" disabled={anyLoading} onClick={clearAllHistory} type="button">
            Очистить всю историю
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
          <p className="muted">{scenario.description}</p>
        </div>

        <section className="chat-shell day8-chat" aria-label={`Сообщения сценария: ${scenario.title}`}>
          <div className="system-context">
            <strong>System:</strong> {systemPrompt}
          </div>
          <div className="chat-list" aria-live="polite">
            {messages.length === 0 && (
              <div className="empty-chat-state">
                Диалог пока пуст. Первое учебное сообщение уже находится в поле ввода.
              </div>
            )}

            {messages.map((item, index) => (
              <ChatMessage item={item} key={`${activeScenario}-${index}`} />
            ))}

            {loading[activeScenario] && (
              <div className="chat-message assistant-message">
                <span className="chat-role">Assistant</span>
                <p className="muted">OpenRouter обрабатывает отправленный контекст…</p>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              runScenario(activeScenario);
            }}
          >
            <label>
              Сообщение пользователя
              <textarea
                disabled={loading[activeScenario]}
                onChange={(event) => updateDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.repeat ||
                    event.nativeEvent.isComposing
                  ) {
                    return;
                  }
                  event.preventDefault();
                  if (canSend) {
                    runScenario(activeScenario);
                  }
                }}
                rows={activeScenario === "overflow" ? 7 : 4}
                value={draft}
              />
            </label>

            <section className={`token-live-panel ${exceedsLimit ? "overflow-result" : ""}`}>
              <div className="token-panel-heading">
                <strong>Подсчёт токенов до отправки</strong>
                <span>{exceedsLimit ? "Лимит превышен" : `${limitUsed}% окна`}</span>
              </div>
              <div className="context-meter" aria-label={`Использовано ${limitUsed}% контекстного окна`}>
                <span style={{ width: `${limitUsed}%` }} />
              </div>
              <div className="token-grid">
                <div><span>Текущий запрос</span><strong>≈ {formatTokenCount(tokenCounts.current)}</strong></div>
                <div><span>Вся история</span><strong>≈ {formatTokenCount(tokenCounts.history)}</strong></div>
                <div><span>Весь вход</span><strong>≈ {formatTokenCount(tokenCounts.input)}</strong></div>
                <div><span>Резерв ответа</span><strong>{formatTokenCount(Number(maxTokens || 0))}</strong></div>
                <div><span>Вход + резерв</span><strong>≈ {formatTokenCount(tokenCounts.withResponse)}</strong></div>
                <div><span>Лимит модели</span><strong>{formatTokenCount(Number(contextLimit || 0))}</strong></div>
                <div><span>Последний ответ API</span><strong>{formatTokenCount(result?.tokenCounts?.actualResponse)}</strong></div>
                <div><span>Последний вход API</span><strong>{formatTokenCount(result?.tokenCounts?.actualInput)}</strong></div>
              </div>
              {exceedsLimit && (
                <p className="error-message">
                  Запрос будет отправлен полностью. В сценарии «Переполнение» OpenRouter
                  автоматически сократит его середину через context-compression перед вызовом
                  модели.
                </p>
              )}
            </section>

            <div className="button-row">
              <span className="field-hint">
                Enter — отправить · Shift+Enter — новая строка. Отправятся system + сообщения
                чата + этот текст.
              </span>
              <button
                className="primary-button"
                disabled={!canSend}
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
                <p className="eyebrow">Последний запрос</p>
                <h3>{result.failed ? "OpenRouter вернул ошибку" : result.model}</h3>
              </div>
              <div className="result-actions">
                <span className={`accuracy-badge ${result.failed ? "incorrect" : "correct"}`}>
                  {result.failed
                    ? "Ответ LLM не создан"
                    : result.compressionEnabled
                      ? "Ответ после сжатия"
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

            {!result.failed && <ResultMetrics result={result} />}
            {result.failed && <p className="error-message">{result.reason}</p>}
            <RequestDetails
              request={result.httpRequest}
              title={result.failed ? "Технические детали отправленного запроса" : undefined}
            />
          </section>
        )}
      </section>

      {allReady && (
        <section className="result-card final-comparison" aria-live="polite">
          <p className="eyebrow">Итоговое сравнение последних запросов</p>
          <div className="markdown-body">
            <MarkdownContent>{buildComparison(results)}</MarkdownContent>
          </div>
        </section>
      )}
    </section>
  );
}
