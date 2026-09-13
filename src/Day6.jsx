import { useState } from "react";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  DEFAULT_DAY6_MESSAGE,
} from "../shared/day6.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Реализуйте простого агента, который:

- 👉 принимает запрос пользователя
- 👉 отправляет его в LLM через API
- 👉 получает ответ
- 👉 выводит результат в интерфейсе

Важно: агент должен быть отдельной сущностью, а логика запроса и ответа должна быть инкапсулирована в агенте.

**Результат:** агент принимает запрос и корректно вызывает LLM через API.`;

function downloadTurn(turn) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(turn.result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `day6-agent-${turn.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Day6({ hasApiKey, onOpenSettings }) {
  const [agentName, setAgentName] = useState(DEFAULT_AGENT_NAME);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_AGENT_SYSTEM_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(500);
  const [temperature, setTemperature] = useState(0.7);
  const [message, setMessage] = useState(DEFAULT_DAY6_MESSAGE);
  const [turns, setTurns] = useState([]);

  const pendingCount = turns.filter((turn) => turn.status === "pending").length;
  const settingsDisabled = pendingCount > 0;

  async function sendMessage(event) {
    event.preventDefault();
    const userMessage = message.trim();
    if (!userMessage) {
      return;
    }

    const id = crypto.randomUUID();
    const settings = {
      agentName,
      systemPrompt,
      message: userMessage,
      model,
      maxTokens: Number(maxTokens),
      temperature: Number(temperature),
    };
    setTurns((current) => [...current, { id, userMessage, status: "pending", result: null }]);
    setMessage("");

    try {
      const result = await apiRequest("/api/day6/chat", {
        method: "POST",
        body: JSON.stringify(settings),
      });
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? { ...turn, status: "done", result } : turn)),
      );
    } catch (requestError) {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id ? { ...turn, status: "error", error: requestError.message } : turn,
        ),
      );
    }
  }

  function resetSettings() {
    setAgentName(DEFAULT_AGENT_NAME);
    setSystemPrompt(DEFAULT_AGENT_SYSTEM_PROMPT);
    setModel(DEFAULT_MODEL);
    setMaxTokens(500);
    setTemperature(0.7);
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 6</p>
          <h2>Первый агент</h2>
          <p className="muted">Отдельная сущность принимает сообщение и вызывает LLM.</p>
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
          <span className="agent-avatar" aria-hidden="true">A</span>
          <div>
            <strong>{agentName || "Без имени"}</strong>
            <p>Серверная сущность: <code>LlmAgent</code></p>
          </div>
        </div>
        <span className="status ready">Готов</span>
      </div>

      <details className="agent-architecture">
        <summary>Как проходит запрос</summary>
        <ol>
          <li>UI отправляет сообщение на <code>POST /api/day6/chat</code>.</li>
          <li><code>LlmAgent</code> добавляет системную инструкцию и вызывает OpenRouter.</li>
          <li>Агент возвращает ответ и метрики в чат.</li>
        </ol>
        <p>В Дне 6 сообщения независимы. Сохранение и восстановление контекста появится в Дне 7.</p>
      </details>

      <div className="experiment-form agent-settings">
        <div className="field-grid">
          <label>
            Имя агента
            <input
              disabled={settingsDisabled}
              onChange={(event) => setAgentName(event.target.value)}
              value={agentName}
            />
          </label>
          <label>
            Максимум токенов
            <input
              disabled={settingsDisabled}
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
            disabled={settingsDisabled}
            onChange={(event) => setSystemPrompt(event.target.value)}
            rows="4"
            value={systemPrompt}
          />
        </label>
        <div className="field-grid">
          <label>
            Модель OpenRouter
            <input
              disabled={settingsDisabled}
              onChange={(event) => setModel(event.target.value)}
              value={model}
            />
          </label>
          <label>
            Temperature
            <input
              disabled={settingsDisabled}
              max="2"
              min="0"
              onChange={(event) => setTemperature(event.target.value)}
              step="0.1"
              type="number"
              value={temperature}
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="secondary-button"
            disabled={settingsDisabled}
            onClick={resetSettings}
            type="button"
          >
            Сбросить настройки
          </button>
          <button
            className="secondary-button"
            disabled={settingsDisabled || turns.length === 0}
            onClick={() => setTurns([])}
            type="button"
          >
            Очистить чат
          </button>
        </div>
      </div>

      <section className="chat-shell" aria-label="Чат с агентом">
        <div className="chat-list" aria-live="polite">
          {turns.length === 0 && (
            <p className="chat-empty">Отправь первое сообщение — ответ появится здесь.</p>
          )}

          {turns.map((turn) => (
            <article className="chat-turn" key={turn.id}>
              <div className="chat-message user-message">
                <p>{turn.userMessage}</p>
              </div>
              <div className="chat-message assistant-message">
                {turn.status === "pending" && <p className="muted">Агент думает…</p>}
                {turn.status === "error" && <p className="error-message">{turn.error}</p>}
                {turn.result && (
                  <>
                    <div className="chat-response-heading">
                      <strong>{turn.result.agent.name}</strong>
                      <button
                        className="secondary-button"
                        onClick={() => downloadTurn(turn)}
                        type="button"
                      >
                        Скачать JSON
                      </button>
                    </div>
                    <div className="markdown-body">
                      <MarkdownContent>
                        {turn.result.response.answer || "Агент не вернул текст."}
                      </MarkdownContent>
                    </div>
                    <ResultMetrics result={turn.result.response} />
                    <RequestDetails request={turn.result.response.httpRequest} />
                  </>
                )}
              </div>
            </article>
          ))}
        </div>

        <form className="chat-composer" onSubmit={sendMessage}>
          <label>
            Сообщение агенту
            <textarea
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Напиши запрос…"
              rows="4"
              value={message}
            />
          </label>
          <div className="button-row">
            <span className="field-hint">
              {pendingCount ? `Параллельно выполняется: ${pendingCount}` : "Можно отправлять запросы подряд."}
            </span>
            <button
              className="primary-button"
              disabled={!hasApiKey || !message.trim() || temperature === ""}
              type="submit"
            >
              Отправить агенту
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}
