import { useEffect, useState } from "react";
import {
  DAY7_RECALL_MESSAGE,
  DAY7_REMEMBER_MESSAGE,
  DEFAULT_DAY7_AGENT_NAME,
  DEFAULT_DAY7_SYSTEM_PROMPT,
} from "../shared/day7.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Добавьте агенту сохранение контекста:

- 👉 храните историю диалога (messages) в JSON или SQLite
- 👉 при перезапуске агента загружайте историю обратно
- 👉 продолжайте диалог так, как будто агент не выключался

Проверьте на практике:

- 👉 начните диалог
- 👉 перезапустите приложение
- 👉 продолжите диалог и убедитесь, что агент помнит прошлые сообщения

**Результат:** агент сохраняет и восстанавливает контекст между запусками.`;

function downloadResult(result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "day7-persistent-context.json";
  link.click();
  URL.revokeObjectURL(url);
}

export function Day7({ hasApiKey, onOpenSettings }) {
  const [agentName, setAgentName] = useState(DEFAULT_DAY7_AGENT_NAME);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY7_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(500);
  const [temperature, setTemperature] = useState(0.7);
  const [message, setMessage] = useState(DAY7_REMEMBER_MESSAGE);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [latestResult, setLatestResult] = useState(null);

  useEffect(() => {
    apiRequest("/api/day7/history")
      .then((result) => {
        setHistory(result.messages);
        if (result.messages.length > 0) {
          setMessage(DAY7_RECALL_MESSAGE);
        }
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setIsLoading(false));
  }, []);

  async function sendMessage(event) {
    event.preventDefault();
    const userMessage = message.trim();
    if (!userMessage || isSending) {
      return;
    }

    setError("");
    setIsSending(true);
    try {
      const result = await apiRequest("/api/day7/chat", {
        method: "POST",
        body: JSON.stringify({
          agentName,
          systemPrompt,
          message: userMessage,
          model,
          maxTokens: Number(maxTokens),
          temperature: Number(temperature),
        }),
      });
      setHistory(result.history);
      setLatestResult(result);
      setMessage(DAY7_RECALL_MESSAGE);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSending(false);
    }
  }

  async function clearHistory() {
    if (!window.confirm("Удалить сохранённую историю Дня 7 из SQLite?")) {
      return;
    }

    setError("");
    try {
      const result = await apiRequest("/api/day7/history", { method: "DELETE" });
      setHistory(result.messages);
      setLatestResult(null);
      setMessage(DAY7_REMEMBER_MESSAGE);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function resetSettings() {
    setAgentName(DEFAULT_DAY7_AGENT_NAME);
    setSystemPrompt(DEFAULT_DAY7_SYSTEM_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(500);
    setTemperature(0.7);
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 7</p>
          <h2>Сохранение контекста</h2>
          <p className="muted">История диалога переживает перезапуск приложения.</p>
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

      <div className="agent-identity">
        <div>
          <span className="agent-avatar" aria-hidden="true">M</span>
          <div>
            <strong>{agentName || "Без имени"}</strong>
            <p>Память: <code>data/agent.sqlite</code></p>
          </div>
        </div>
        <span className="status ready">SQLite · {history.length} сообщ.</span>
      </div>

      <details className="agent-architecture" open>
        <summary>Как показать сохранение контекста на видео</summary>
        <ol>
          <li>Нажми «Шаг 1», затем отправь сообщение с фактом.</li>
          <li>Останови сервер сочетанием <code>Ctrl+C</code> и снова выполни <code>npm run dev</code>.</li>
          <li>Обнови страницу, открой День 7 и нажми «Шаг 2».</li>
          <li>В запрос уйдёт восстановленная из SQLite история, поэтому агент назовёт JavaScript.</li>
        </ol>
      </details>

      <div className="experiment-form agent-settings">
        <div className="field-grid">
          <label>
            Имя агента
            <input
              disabled={isSending}
              onChange={(event) => setAgentName(event.target.value)}
              value={agentName}
            />
          </label>
          <label>
            Максимум токенов
            <input
              disabled={isSending}
              max="8192"
              min="1"
              onChange={(event) => setMaxTokens(event.target.value)}
              type="number"
              value={maxTokens}
            />
          </label>
        </div>
        <label>
          Системная инструкция агента
          <textarea
            disabled={isSending}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows="4"
            value={systemPrompt}
          />
        </label>
        <div className="field-grid">
          <label>
            Модель OpenRouter
            <input
              disabled={isSending}
              onChange={(event) => setModel(event.target.value)}
              value={model}
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
          <button
            className="secondary-button"
            disabled={isSending}
            onClick={resetSettings}
            type="button"
          >
            Сбросить настройки
          </button>
          <button
            className="secondary-button"
            disabled={isSending || history.length === 0}
            onClick={clearHistory}
            type="button"
          >
            Очистить SQLite-историю
          </button>
        </div>
      </div>

      <div className="memory-demo-actions">
        <button
          className="secondary-button"
          disabled={isSending}
          onClick={() => setMessage(DAY7_REMEMBER_MESSAGE)}
          type="button"
        >
          Шаг 1: сохранить факт
        </button>
        <button
          className="secondary-button"
          disabled={isSending}
          onClick={() => setMessage(DAY7_RECALL_MESSAGE)}
          type="button"
        >
          Шаг 2: проверить память
        </button>
      </div>

      <section className="chat-shell" aria-label="Чат с постоянной памятью">
        <div className="chat-list" aria-live="polite">
          {isLoading && <p className="chat-empty">Загружаю историю из SQLite…</p>}
          {!isLoading && history.length === 0 && !isSending && (
            <p className="chat-empty">История пуста. Начни с первого шага.</p>
          )}

          {history.map((item) => (
            <div
              className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}
              key={item.id}
            >
              <span className="chat-role">{item.role === "user" ? "Ты" : agentName}</span>
              {item.role === "assistant" ? (
                <div className="markdown-body">
                  <MarkdownContent>{item.content}</MarkdownContent>
                </div>
              ) : (
                <p>{item.content}</p>
              )}
            </div>
          ))}

          {isSending && (
            <>
              <div className="chat-message user-message">
                <span className="chat-role">Ты</span>
                <p>{message.trim()}</p>
              </div>
              <div className="chat-message assistant-message">
                <span className="chat-role">{agentName}</span>
                <p className="muted">Агент читает сохранённую историю…</p>
              </div>
            </>
          )}
        </div>

        <form className="chat-composer" onSubmit={sendMessage}>
          <label>
            Сообщение агенту
            <textarea
              disabled={isSending}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Напиши запрос…"
              rows="4"
              value={message}
            />
          </label>
          <div className="button-row">
            <span className="field-hint">
              Каждый успешный обмен автоматически сохраняется в SQLite.
            </span>
            <button
              className="primary-button"
              disabled={!hasApiKey || !message.trim() || isLoading || isSending || temperature === ""}
              type="submit"
            >
              {isSending ? "Отправляю…" : "Отправить агенту"}
            </button>
          </div>
        </form>
      </section>

      {error && <p className="error-message result-message">{error}</p>}

      {latestResult && (
        <section className="result-card">
          <div className="result-heading">
            <div>
              <p className="eyebrow">Последний вызов</p>
              <h3>Что вернул агент</h3>
            </div>
            <button
              className="secondary-button"
              onClick={() => downloadResult(latestResult)}
              type="button"
            >
              Скачать JSON
            </button>
          </div>
          <div className="answer markdown-body">
            <MarkdownContent>{latestResult.response.answer}</MarkdownContent>
          </div>
          <ResultMetrics result={latestResult.response} />
          <RequestDetails request={latestResult.response.httpRequest} />
        </section>
      )}
    </section>
  );
}
