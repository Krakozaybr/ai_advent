import { useEffect, useMemo, useRef, useState } from "react";
import {
  DAY9_VARIANTS,
  DEFAULT_DAY9_KEEP_LAST,
  DEFAULT_DAY9_SUMMARY_MAX_TOKENS,
  DEFAULT_DAY9_SYSTEM_PROMPT,
  getDay9ScriptPrompt,
} from "../shared/day9.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { estimateMessagesTokens, estimateTextTokens } from "../shared/token-counter.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Реализуйте механизм управления контекстом:

- 👉 храните последние N сообщений «как есть»
- 👉 остальное заменяйте summary
- 👉 храните summary отдельно и подставляйте его вместо полной истории

Сравните качество ответов без сжатия и со сжатием, а также расход токенов до и после.

**Результат:** агент работает с компрессией истории и экономит токены.`;

const FACT_PATTERNS = [
  /AI Advent/iu,
  /локаль/iu,
  /10|десят/iu,
  /OpenRouter/iu,
  /Qwen/iu,
  /SQLite/iu,
  /API[- ]?ключ/iu,
];

function emptyHistories() {
  return { full: [], compressed: [] };
}

function formatTokens(value) {
  return value == null ? "—" : value.toLocaleString("ru-RU");
}

function factScore(answer = "") {
  return FACT_PATTERNS.filter((pattern) => pattern.test(answer)).length;
}

function downloadResult(result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "day9-context-compression.json";
  link.click();
  URL.revokeObjectURL(url);
}

function ChatMessage({ item }) {
  return (
    <div className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}>
      <span className="chat-role">{item.role === "user" ? "User" : "Assistant"}</span>
      {item.role === "assistant" ? (
        <div className="markdown-body">
          <MarkdownContent>{item.content}</MarkdownContent>
        </div>
      ) : (
        <p>{item.content}</p>
      )}
    </div>
  );
}

export function Day9({ hasApiKey, onOpenSettings }) {
  const [activeVariant, setActiveVariant] = useState("full");
  const [histories, setHistories] = useState(emptyHistories);
  const [summary, setSummary] = useState("");
  const [summarizedMessageCount, setSummarizedMessageCount] = useState(0);
  const [message, setMessage] = useState(() => getDay9ScriptPrompt(0));
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY9_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(300);
  const [summaryMaxTokens, setSummaryMaxTokens] = useState(
    DEFAULT_DAY9_SUMMARY_MAX_TOKENS,
  );
  const [keepLast, setKeepLast] = useState(DEFAULT_DAY9_KEEP_LAST);
  const [temperature, setTemperature] = useState(0.2);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [latestResult, setLatestResult] = useState(null);
  const chatEndRef = useRef(null);

  const activeHistory = histories[activeVariant];
  const activeResponse = latestResult?.responses?.[activeVariant];
  const canSend = Boolean(
    hasApiKey &&
      !isSending &&
      message.trim() &&
      systemPrompt.trim() &&
      model.trim() &&
      temperature !== "",
  );

  const previewCounts = useMemo(() => {
    const fullMessages = [
      { role: "system", content: systemPrompt },
      ...histories.full,
      { role: "user", content: message },
    ];
    const boundary = Math.max(
      summarizedMessageCount,
      histories.compressed.length - Number(keepLast || 0),
    );
    const recent = histories.compressed.slice(boundary);
    const compressedMessages = [
      { role: "system", content: systemPrompt },
      ...(summary
        ? [{ role: "system", content: `Summary старой части диалога:\n${summary}` }]
        : []),
      ...recent,
      { role: "user", content: message },
    ];
    const full = estimateMessagesTokens(fullMessages);
    const compressed = estimateMessagesTokens(compressedMessages);

    return {
      current: estimateTextTokens(message),
      full,
      compressed,
      saved: Math.max(0, full - compressed),
    };
  }, [histories, keepLast, message, summarizedMessageCount, summary, systemPrompt]);

  useEffect(() => {
    if (activeHistory.length === 0 && !isSending) {
      return undefined;
    }
    const animationFrame = requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [activeHistory.length, activeVariant, isSending]);

  async function sendMessage(event) {
    event?.preventDefault();
    const userMessage = message.trim();
    if (!canSend || !userMessage) {
      return;
    }

    setIsSending(true);
    setError("");
    try {
      const result = await apiRequest("/api/day9/compare", {
        method: "POST",
        body: JSON.stringify({
          systemPrompt,
          message: userMessage,
          model,
          maxTokens: Number(maxTokens),
          summaryMaxTokens: Number(summaryMaxTokens),
          keepLast: Number(keepLast),
          temperature: Number(temperature),
          fullHistory: histories.full,
          compressedHistory: histories.compressed,
          summary,
          summarizedMessageCount,
        }),
      });

      setHistories({
        full: [
          ...histories.full,
          { role: "user", content: userMessage },
          { role: "assistant", content: result.responses.full.answer },
        ],
        compressed: [
          ...histories.compressed,
          { role: "user", content: userMessage },
          { role: "assistant", content: result.responses.compressed.answer },
        ],
      });
      setSummary(result.summary.text);
      setSummarizedMessageCount(result.summary.summarizedMessageCount);
      setLatestResult(result);

      const completedUserMessages =
        histories.full.filter((item) => item.role === "user").length + 1;
      setMessage(getDay9ScriptPrompt(completedUserMessages));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSending(false);
    }
  }

  function clearExperiment() {
    setHistories(emptyHistories());
    setSummary("");
    setSummarizedMessageCount(0);
    setMessage(getDay9ScriptPrompt(0));
    setLatestResult(null);
    setError("");
  }

  function resetSettings() {
    setSystemPrompt(DEFAULT_DAY9_SYSTEM_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(300);
    setSummaryMaxTokens(DEFAULT_DAY9_SUMMARY_MAX_TOKENS);
    setKeepLast(DEFAULT_DAY9_KEEP_LAST);
    setTemperature(0.2);
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 9</p>
          <h2>Сжатие истории</h2>
          <p className="muted">Один запрос, два контекста: полная история и summary + последние N.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Для сравнения нужен ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">
            Открыть настройки
          </button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture" open>
        <summary>Как показать День 9 на видео</summary>
        <ol>
          <li>Оставь N = 4 и пять раз отправь подставленные сообщения.</li>
          <li>После третьего обмена старые сообщения начнут уходить в отдельный summary.</li>
          <li>На последнем вопросе сравни ответы двух вкладок и точные токены OpenRouter.</li>
          <li>Покажи JSON с разными массивами <code>messages</code>.</li>
        </ol>
        <p>Обычная отправка делает два параллельных запроса; обновление summary добавляет ещё один.</p>
      </details>

      <div className="experiment-form agent-settings">
        <label>
          Системная инструкция
          <textarea
            disabled={isSending}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows="4"
            value={systemPrompt}
          />
        </label>
        <div className="day9-settings-grid">
          <label>
            Модель OpenRouter
            <input disabled={isSending} onChange={(event) => setModel(event.target.value)} value={model} />
          </label>
          <label>
            Последние N сообщений
            <input
              disabled={isSending}
              max="40"
              min="1"
              onChange={(event) => setKeepLast(event.target.value)}
              type="number"
              value={keepLast}
            />
          </label>
          <label>
            Максимум ответа
            <input
              disabled={isSending}
              max="8192"
              min="1"
              onChange={(event) => setMaxTokens(event.target.value)}
              type="number"
              value={maxTokens}
            />
          </label>
          <label>
            Максимум summary
            <input
              disabled={isSending}
              max="2048"
              min="1"
              onChange={(event) => setSummaryMaxTokens(event.target.value)}
              type="number"
              value={summaryMaxTokens}
            />
          </label>
          <label>
            Temperature
            <input
              disabled={isSending}
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
          <button className="secondary-button" disabled={isSending} onClick={resetSettings} type="button">
            Сбросить настройки
          </button>
          <button className="secondary-button" disabled={isSending} onClick={clearExperiment} type="button">
            Очистить весь эксперимент
          </button>
        </div>
      </div>

      <section className="day9-summary-panel">
        <div className="token-panel-heading">
          <strong>Отдельная summary-memory</strong>
          <span>{summarizedMessageCount} сообщ. заменено</span>
        </div>
        {summary ? (
          <div className="markdown-body"><MarkdownContent>{summary}</MarkdownContent></div>
        ) : (
          <p className="muted">Пока пусто. Summary появится, когда история станет длиннее N.</p>
        )}
      </section>

      <div className="variant-tabs method-tabs" role="tablist" aria-label="Варианты истории">
        {Object.entries(DAY9_VARIANTS).map(([id, variant]) => (
          <button
            aria-controls="day9-chat-panel"
            aria-selected={activeVariant === id}
            className={activeVariant === id ? "variant-tab active" : "variant-tab"}
            key={id}
            onClick={() => setActiveVariant(id)}
            role="tab"
            type="button"
          >
            {variant.title}
          </button>
        ))}
      </div>

      <section className="variant-panel" id="day9-chat-panel" role="tabpanel">
        <div className="variant-heading">
          <h3>{DAY9_VARIANTS[activeVariant].title}</h3>
          <p className="muted">{DAY9_VARIANTS[activeVariant].description}</p>
        </div>

        <section className="chat-shell" aria-label={`День 9: ${DAY9_VARIANTS[activeVariant].title}`}>
          <div className="chat-list" aria-live="polite">
            {activeHistory.length === 0 && !isSending && (
              <p className="chat-empty">Диалог пока пуст. Первое сообщение находится в поле ввода.</p>
            )}
            {activeHistory.map((item, index) => (
              <ChatMessage item={item} key={`${activeVariant}-${index}`} />
            ))}
            {isSending && (
              <>
                <div className="chat-message user-message"><span className="chat-role">User</span><p>{message.trim()}</p></div>
                <div className="chat-message assistant-message"><span className="chat-role">Assistant</span><p className="muted">Сравниваю полный и сжатый контекст…</p></div>
              </>
            )}
            <div ref={chatEndRef} />
          </div>

          <form className="chat-composer" onSubmit={sendMessage}>
            <label>
              Одинаковое сообщение для двух вариантов
              <textarea
                disabled={isSending}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing) {
                    return;
                  }
                  event.preventDefault();
                  if (canSend) {
                    sendMessage();
                  }
                }}
                placeholder="Напиши сообщение…"
                rows="4"
                value={message}
              />
            </label>

            <div className="token-live-panel">
              <div className="token-panel-heading">
                <strong>Оценка следующего входа</strong>
                <span>экономия ≈ {formatTokens(previewCounts.saved)}</span>
              </div>
              <div className="token-grid">
                <div><span>Текущий запрос</span><strong>≈ {formatTokens(previewCounts.current)}</strong></div>
                <div><span>Полная история</span><strong>≈ {formatTokens(previewCounts.full)}</strong></div>
                <div><span>Summary + последние N</span><strong>≈ {formatTokens(previewCounts.compressed)}</strong></div>
                <div><span>Summary</span><strong>≈ {formatTokens(estimateTextTokens(summary))}</strong></div>
              </div>
            </div>

            <div className="button-row">
              <span className="field-hint">Enter — отправить · Shift+Enter — новая строка.</span>
              <button className="primary-button" disabled={!canSend} type="submit">
                {isSending ? "Сравниваю…" : "Отправить в оба варианта"}
              </button>
            </div>
          </form>
        </section>
      </section>

      {error && <p className="error-message result-message">{error}</p>}

      {latestResult && (
        <section className="result-card">
          <div className="result-heading">
            <div><p className="eyebrow">Последнее сравнение</p><h3>Токены и качество</h3></div>
            <div className="result-actions">
              <span className="status ready">
                Сэкономлено {formatTokens(latestResult.tokenCounts.actualSaved)} токенов
              </span>
              <button className="secondary-button" onClick={() => downloadResult(latestResult)} type="button">
                Скачать JSON
              </button>
            </div>
          </div>

          <div className="token-grid">
            <div><span>Без сжатия · вход</span><strong>{formatTokens(latestResult.tokenCounts.actualFullInput)}</strong></div>
            <div><span>Со сжатием · вход</span><strong>{formatTokens(latestResult.tokenCounts.actualCompressedInput)}</strong></div>
            <div><span>Экономия · вход</span><strong>{formatTokens(latestResult.tokenCounts.actualSaved)}</strong></div>
            <div><span>Обновление summary</span><strong>{formatTokens(latestResult.tokenCounts.summaryInput)} + {formatTokens(latestResult.tokenCounts.summaryOutput)}</strong></div>
          </div>

          <div className="day9-answer-comparison">
            {Object.entries(DAY9_VARIANTS).map(([id, variant]) => (
              <article key={id}>
                <span className="chat-role">{variant.title} · фактов {factScore(latestResult.responses[id].answer)}/{FACT_PATTERNS.length}</span>
                <div className="markdown-body"><MarkdownContent>{latestResult.responses[id].answer}</MarkdownContent></div>
              </article>
            ))}
          </div>
          <p className="field-hint">Счётчик фактов полезен для последнего учебного вопроса; до него ответы только подтверждают отдельные требования.</p>

          <ResultMetrics result={activeResponse} />
          <RequestDetails
            request={activeResponse.httpRequest}
            title={`Технические детали: ${DAY9_VARIANTS[activeVariant].title}`}
          />
          {latestResult.summary.response && (
            <RequestDetails
              request={latestResult.summary.response.httpRequest}
              title="Технические детали обновления summary"
            />
          )}
        </section>
      )}
    </section>
  );
}
