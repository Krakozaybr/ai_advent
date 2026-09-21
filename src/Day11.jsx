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

Разные типы памяти должны храниться отдельно. Агент явно выбирает слой через MCP-инструмент, а пользователь видит, редактирует и удаляет записи.

Проверьте, какие данные попадают в каждый слой и как они влияют на ответы агента.

**Результат:** агент с явной моделью памяти (memory layers).

[Видео из задания](https://disk.yandex.ru/i/PB0YJYNtyL0-gA)`;

function createEmptyState() {
  return {
    messages: [],
    layers: { shortTerm: [], working: [], longTerm: [] },
    mcp: { server: "ai-advent-memory", transport: "stdio", tools: [] },
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

function MemoryLayer({ disabled, id, items, messageCount, onClear, onDelete }) {
  const layer = DAY11_MEMORY_LAYERS[id];
  const itemCount = items.length + (messageCount || 0);
  return (
    <article className="memory-layer-card">
      <div className="memory-layer-heading">
        <div>
          <h3>{layer.title}</h3>
          <p>{layer.description}</p>
        </div>
        <span>{itemCount}</span>
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
      <button
        className="secondary-button memory-layer-clear"
        disabled={disabled || itemCount === 0}
        onClick={() => onClear(id)}
        type="button"
      >
        Очистить слой
      </button>
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
  const [activeResultVariant, setActiveResultVariant] = useState("withMemory");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [clearingLayer, setClearingLayer] = useState(null);
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

  async function clearLayer(layer) {
    const layerTitle = DAY11_MEMORY_LAYERS[layer].title;
    const details = layer === "shortTerm" ? " Текущий диалог тоже будет удалён." : "";
    if (!window.confirm(`Очистить слой «${layerTitle}»?${details}`)) {
      return;
    }
    setClearingLayer(layer);
    setError("");
    try {
      const nextState = await apiRequest(`/api/day11/memory/${encodeURIComponent(layer)}`, {
        method: "DELETE",
      });
      setState(nextState);
      setResult(null);
      setActiveResultVariant("withMemory");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setClearingLayer(null);
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
      setActiveResultVariant("withMemory");
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
      setActiveResultVariant("withMemory");
      setState((current) => ({ ...nextResult.state, mcp: current.mcp }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSending(false);
    }
  }

  const disabled = isLoading || isSaving || isSending || clearingLayer !== null;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 11</p>
          <h2>Модель памяти агента</h2>
          <p className="muted">Три слоя SQLite, локальный MCP-сервер и сравнение ответа с памятью и без неё.</p>
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
          <li>Очисти память и отправь подготовленное сообщение со словом «Запомни».</li>
          <li>Покажи MCP-вызов memory_save: выбранный слой, ключ, значение и причину.</li>
          <li>Покажи, что новая запись появилась в рабочей памяти автоматически.</li>
          <li>При необходимости исправь запись вручную и сравни два ответа.</li>
        </ol>
      </details>

      <section className="day11-mcp-overview">
        <div><p className="eyebrow">Локальный MCP</p><h3>{state.mcp?.server || "ai-advent-memory"}</h3><p>Express запускает сервер памяти отдельным процессом через <code>stdio</code>. Модель получает только безопасный инструмент <code>memory_save</code>.</p></div>
        <div className="mcp-tool-chips">{(state.mcp?.tools || []).map((tool) => <code key={tool}>{tool}</code>)}</div>
      </section>

      <section className="day11-memory-section">
        <div className="day11-memory-grid">
          {Object.keys(DAY11_MEMORY_LAYERS).map((layer) => (
            <MemoryLayer
              disabled={disabled}
              id={layer}
              items={state.layers[layer]}
              key={layer}
              messageCount={layer === "shortTerm" ? state.messages.length : 0}
              onClear={clearLayer}
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
          <div className="variant-tabs day11-result-tabs" role="tablist" aria-label="Вариант ответа">
            <button
              aria-controls="day11-result-panel"
              aria-selected={activeResultVariant === "withoutMemory"}
              className={activeResultVariant === "withoutMemory" ? "variant-tab active" : "variant-tab"}
              onClick={() => setActiveResultVariant("withoutMemory")}
              role="tab"
              type="button"
            >
              Без памяти
            </button>
            <button
              aria-controls="day11-result-panel"
              aria-selected={activeResultVariant === "withMemory"}
              className={activeResultVariant === "withMemory" ? "variant-tab active" : "variant-tab"}
              onClick={() => setActiveResultVariant("withMemory")}
              role="tab"
              type="button"
            >
              С памятью
              {result.mcp.toolCalls.length > 0 && ` · MCP ${result.mcp.toolCalls.length}`}
            </button>
          </div>
          <section className="variant-panel day11-result-panel" id="day11-result-panel" role="tabpanel">
            {activeResultVariant === "withoutMemory" ? (
              <>
                <div className="variant-heading">
                  <p className="eyebrow">Без памяти</p>
                  <h3>Только текущий запрос</h3>
                  <p className="muted">История диалога и записи из слоёв памяти не передавались модели.</p>
                </div>
                <div className="markdown-body"><MarkdownContent>{result.responses.withoutMemory.answer}</MarkdownContent></div>
                <ResultMetrics result={result.responses.withoutMemory} />
                <RequestDetails request={result.responses.withoutMemory.httpRequest} title="Технические детали запроса без памяти" />
              </>
            ) : (
              <>
                <div className="variant-heading">
                  <p className="eyebrow">С памятью</p>
                  <h3>Все три слоя и MCP</h3>
                  <p className="muted">Модель получила историю диалога, рабочие данные и долговременную память.</p>
                </div>
                <div className="markdown-body"><MarkdownContent>{result.responses.withMemory.answer}</MarkdownContent></div>
                <ResultMetrics result={result.responses.withMemory} />
                <RequestDetails request={result.responses.withMemory.httpRequest} title="Технические детали запроса с памятью" />
                <section className="mcp-call-log">
                  <div className="result-heading"><div><p className="eyebrow">MCP tool calls</p><h3>Что агент сохранил сам</h3></div><span className="status ready">stdio</span></div>
                  {result.mcp.toolCalls.length === 0 ? (
                    <p className="muted">В этом запросе агент не нашёл нового факта для сохранения.</p>
                  ) : (
                    <div className="mcp-call-list">
                      {result.mcp.toolCalls.map((call) => (
                        <article className={call.isError ? "mcp-call error" : "mcp-call"} key={call.id}>
                          <div className="mcp-call-heading"><code>{call.name}</code><span>{call.isError ? "Ошибка" : "Сохранено"}</span></div>
                          <dl>
                            <div><dt>Слой</dt><dd>{call.arguments.layer || "—"}</dd></div>
                            <div><dt>Ключ</dt><dd>{call.arguments.key || "—"}</dd></div>
                            <div><dt>Значение</dt><dd>{call.arguments.value || "—"}</dd></div>
                            <div><dt>Причина</dt><dd>{call.arguments.reason || "—"}</dd></div>
                          </dl>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </section>
          <div className="token-grid">
            <div><span>Без памяти</span><strong>≈ {formatTokens(result.tokenCounts.estimatedWithoutMemory)}</strong></div>
            <div><span>С памятью</span><strong>≈ {formatTokens(result.tokenCounts.estimatedWithMemory)}</strong></div>
            <div><span>Диалог до запроса</span><strong>{result.context.shortTermMessages}</strong></div>
            <div><span>Записей до MCP</span><strong>{Object.values(result.context.layerItems).reduce((sum, count) => sum + count, 0)}</strong></div>
          </div>
        </section>
      )}
    </section>
  );
}
