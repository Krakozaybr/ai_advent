import { useEffect, useState } from "react";
import {
  DAY11_DEFAULT_MEMORY,
  DAY11_DEFAULT_PROMPT,
  DAY11_MEMORY_LAYERS,
  DEFAULT_DAY11_SYSTEM_PROMPT,
} from "../shared/day11.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Опишите и реализуйте модель памяти для агента.

Разделите информацию минимум на три типа:

- краткосрочная — текущий диалог;
- рабочая — данные текущей задачи;
- долговременная — профиль, решения и знания.

Разные типы памяти должны храниться отдельно. Пользователь явно выбирает, что и куда сохранить.

Проверьте, какие данные попадают в каждый слой и как они влияют на ответы агента.

**Результат:** агент с явной моделью памяти (memory layers).

[Видео из задания](https://disk.yandex.ru/i/PB0YJYNtyL0-gA)`;

function createEmptyState() {
  return {
    messages: [],
    layers: { shortTerm: [], working: [], longTerm: [] },
  };
}

function formatTokens(value) {
  return value == null ? "—" : value.toLocaleString("ru-RU");
}

function downloadResult(result) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "day11-memory-layers.json";
  link.click();
  URL.revokeObjectURL(url);
}

function ChatMessage({ item }) {
  return (
    <div className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}>
      <span className="chat-role">{item.role === "user" ? "User" : "Assistant"}</span>
      {item.role === "assistant" ? (
        <div className="markdown-body"><MarkdownContent>{item.content}</MarkdownContent></div>
      ) : (
        <p>{item.content}</p>
      )}
    </div>
  );
}

function MemoryLayer({ id, items, messageCount, onDelete }) {
  const layer = DAY11_MEMORY_LAYERS[id];
  return (
    <article className="memory-layer-card">
      <div className="memory-layer-heading">
        <div>
          <h3>{layer.title}</h3>
          <p>{layer.description}</p>
        </div>
        <span>{items.length + (messageCount || 0)}</span>
      </div>
      {messageCount > 0 && (
        <p className="memory-dialogue-count">Диалог: {messageCount} сообщ.</p>
      )}
      {items.length === 0 ? (
        <p className="memory-layer-empty">Ручных записей пока нет.</p>
      ) : (
        <ul className="memory-item-list">
          {items.map((item) => (
            <li key={item.key}>
              <div><strong>{item.key}</strong><span>{item.value}</span></div>
              <button
                aria-label={`Удалить ${item.key}`}
                className="text-button"
                onClick={() => onDelete(id, item.key)}
                type="button"
              >
                удалить
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function Day11({ hasApiKey, onOpenSettings }) {
  const [state, setState] = useState(createEmptyState);
  const [activeLayer, setActiveLayer] = useState("shortTerm");
  const [memoryKey, setMemoryKey] = useState(DAY11_DEFAULT_MEMORY.shortTerm.key);
  const [memoryValue, setMemoryValue] = useState(DAY11_DEFAULT_MEMORY.shortTerm.value);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY11_SYSTEM_PROMPT);
  const [message, setMessage] = useState(DAY11_DEFAULT_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(400);
  const [temperature, setTemperature] = useState(0.2);
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/api/day11/state")
      .then(setState)
      .catch((requestError) => setError(requestError.message))
      .finally(() => setIsLoading(false));
  }, []);

  function selectLayer(layer) {
    const example = DAY11_DEFAULT_MEMORY[layer];
    setActiveLayer(layer);
    setMemoryKey(example.key);
    setMemoryValue(example.value);
  }

  async function saveMemory(event) {
    event.preventDefault();
    if (!memoryKey.trim() || !memoryValue.trim() || isSaving) {
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const nextState = await apiRequest("/api/day11/memory", {
        method: "POST",
        body: JSON.stringify({ layer: activeLayer, key: memoryKey, value: memoryValue }),
      });
      setState(nextState);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteMemory(layer, key) {
    setError("");
    try {
      const nextState = await apiRequest(
        `/api/day11/memory/${encodeURIComponent(layer)}/${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
      setState(nextState);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function clearAll() {
    if (!window.confirm("Очистить диалог и все три слоя памяти Дня 11?")) {
      return;
    }
    setError("");
    try {
      const nextState = await apiRequest("/api/day11/state", { method: "DELETE" });
      setState(nextState);
      setResult(null);
      setMessage(DAY11_DEFAULT_PROMPT);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function compareAnswers(event) {
    event.preventDefault();
    if (!message.trim() || isSending) {
      return;
    }
    setIsSending(true);
    setError("");
    try {
      const nextResult = await apiRequest("/api/day11/compare", {
        method: "POST",
        body: JSON.stringify({
          systemPrompt,
          message,
          model,
          maxTokens: Number(maxTokens),
          temperature: Number(temperature),
        }),
      });
      setResult(nextResult);
      setState(nextResult.state);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSending(false);
    }
  }

  const disabled = isLoading || isSaving || isSending;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 11</p>
          <h2>Модель памяти агента</h2>
          <p className="muted">Три слоя SQLite и сравнение ответа с памятью и без неё.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>
          {hasApiKey ? "Ключ готов" : "Нет ключа"}
        </span>
      </div>

      {!hasApiKey && (
        <div className="notice">
          Для сравнения нужен ключ OpenRouter.
          <button className="text-button" onClick={onOpenSettings} type="button">Открыть настройки</button>
        </div>
      )}

      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture" open>
        <summary>Сценарий для видео</summary>
        <ol>
          <li>Выбери каждый слой и сохрани предложенную запись.</li>
          <li>Покажи, что данные разложены по трём отдельным панелям.</li>
          <li>Отправь подготовленный вопрос: приложение сделает два одинаковых запроса.</li>
          <li>Сравни ответы и раскрой технические детали обоих запросов.</li>
        </ol>
      </details>

      <section className="day11-memory-section">
        <div className="day11-memory-grid">
          {Object.keys(DAY11_MEMORY_LAYERS).map((layer) => (
            <MemoryLayer
              id={layer}
              items={state.layers[layer]}
              key={layer}
              messageCount={layer === "shortTerm" ? state.messages.length : 0}
              onDelete={deleteMemory}
            />
          ))}
        </div>

        <form className="memory-editor" onSubmit={saveMemory}>
          <div className="memory-editor-grid">
            <label>
              Слой памяти
              <select disabled={disabled} onChange={(event) => selectLayer(event.target.value)} value={activeLayer}>
                {Object.entries(DAY11_MEMORY_LAYERS).map(([id, layer]) => (
                  <option key={id} value={id}>{layer.title}</option>
                ))}
              </select>
            </label>
            <label>
              Ключ
              <input disabled={disabled} maxLength="80" onChange={(event) => setMemoryKey(event.target.value)} value={memoryKey} />
            </label>
          </div>
          <label>
            Значение
            <textarea disabled={disabled} maxLength="2000" onChange={(event) => setMemoryValue(event.target.value)} rows="3" value={memoryValue} />
          </label>
          <div className="button-row memory-actions">
            <button className="secondary-button" disabled={disabled} onClick={clearAll} type="button">Очистить всю память</button>
            <button className="primary-button" disabled={disabled || !memoryKey.trim() || !memoryValue.trim()} type="submit">
              {isSaving ? "Сохраняю…" : `Сохранить в «${DAY11_MEMORY_LAYERS[activeLayer].title}»`}
            </button>
          </div>
        </form>
      </section>

      <div className="experiment-form agent-settings">
        <label>
          Системная инструкция
          <textarea disabled={isSending} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" value={systemPrompt} />
        </label>
        <div className="day11-settings-grid">
          <label>Модель OpenRouter<input disabled={isSending} onChange={(event) => setModel(event.target.value)} value={model} /></label>
          <label>Максимум ответа<input disabled={isSending} max="8192" min="1" onChange={(event) => setMaxTokens(event.target.value)} type="number" value={maxTokens} /></label>
          <label>Temperature<input disabled={isSending} max="2" min="0" onChange={(event) => setTemperature(event.target.value)} step="0.1" type="number" value={temperature} /></label>
        </div>
      </div>

      <section className="chat-shell">
        <div className="chat-list" aria-live="polite">
          {state.messages.length === 0 && !isSending && <p className="chat-empty">Диалог пока пуст. Сохранённые записи памяти показаны выше.</p>}
          {state.messages.map((item) => <ChatMessage item={item} key={item.id} />)}
          {isSending && (
            <>
              <div className="chat-message user-message"><span className="chat-role">User</span><p>{message}</p></div>
              <div className="chat-message assistant-message"><span className="chat-role">Assistant</span><p className="muted">Агент сравнивает два контекста…</p></div>
            </>
          )}
        </div>
        <form className="chat-composer" onSubmit={compareAnswers}>
          <label>
            Один запрос для двух вариантов
            <textarea
              disabled={isSending}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (hasApiKey && message.trim()) compareAnswers(event);
              }}
              rows="4"
              value={message}
            />
          </label>
          <div className="button-row">
            <span className="field-hint">В историю сохраняется ответ варианта с памятью.</span>
            <button className="primary-button" disabled={!hasApiKey || isSending || !message.trim()} type="submit">
              {isSending ? "Сравниваю…" : "Сравнить ответы"}
            </button>
          </div>
        </form>
      </section>

      {error && <p className="error-message result-message">{error}</p>}

      {result && (
        <section className="result-card">
          <div className="result-heading">
            <div><p className="eyebrow">Сравнение</p><h3>Один вопрос, разный контекст</h3></div>
            <button className="secondary-button" onClick={() => downloadResult(result)} type="button">Скачать JSON</button>
          </div>
          <div className="day11-answer-comparison">
            <article>
              <p className="eyebrow">Без памяти</p>
              <div className="markdown-body"><MarkdownContent>{result.responses.withoutMemory.answer}</MarkdownContent></div>
              <ResultMetrics result={result.responses.withoutMemory} />
              <RequestDetails request={result.responses.withoutMemory.httpRequest} title="Технические детали запроса без памяти" />
            </article>
            <article>
              <p className="eyebrow">Со всеми слоями</p>
              <div className="markdown-body"><MarkdownContent>{result.responses.withMemory.answer}</MarkdownContent></div>
              <ResultMetrics result={result.responses.withMemory} />
              <RequestDetails request={result.responses.withMemory.httpRequest} title="Технические детали запроса с памятью" />
            </article>
          </div>
          <div className="token-grid">
            <div><span>Без памяти</span><strong>≈ {formatTokens(result.tokenCounts.estimatedWithoutMemory)}</strong></div>
            <div><span>С памятью</span><strong>≈ {formatTokens(result.tokenCounts.estimatedWithMemory)}</strong></div>
            <div><span>Сообщений диалога</span><strong>{result.context.shortTermMessages}</strong></div>
            <div><span>Записей по слоям</span><strong>{Object.values(result.context.layerItems).reduce((sum, count) => sum + count, 0)}</strong></div>
          </div>
        </section>
      )}
    </section>
  );
}
