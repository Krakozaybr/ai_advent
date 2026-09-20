import { useEffect, useState } from "react";
import {
  DAY14_CONFLICT_PROMPT,
  DAY14_SAFE_PROMPT,
  DEFAULT_DAY14_SYSTEM_PROMPT,
} from "../shared/day14.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Добавьте в ассистента инварианты, которые он не имеет права нарушать.

- храните инварианты отдельно от диалога;
- явно учитывайте их в запросе;
- отказывайтесь выполнять запросы, которые им противоречат;
- проверьте конфликт и объяснение отказа.

**Результат:** ассистент, работающий в рамках заданных инвариантов.`;

export function Day14({ hasApiKey, onOpenSettings }) {
  const [invariants, setInvariants] = useState([]);
  const [category, setCategory] = useState("Бизнес-правило");
  const [rule, setRule] = useState("Не предлагать платную подписку.");
  const [terms, setTerms] = useState("подписка, premium");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY14_SYSTEM_PROMPT);
  const [message, setMessage] = useState(DAY14_CONFLICT_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(400);
  const [temperature, setTemperature] = useState(0.2);
  const [result, setResult] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiRequest("/api/day14/state")
      .then((state) => setInvariants(state.invariants))
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function addInvariant(event) {
    event.preventDefault();
    setIsBusy(true);
    setError("");
    try {
      const state = await apiRequest("/api/day14/invariants", {
        method: "POST",
        body: JSON.stringify({
          category,
          rule,
          forbiddenTerms: terms.split(",").map((term) => term.trim()).filter(Boolean),
        }),
      });
      setInvariants(state.invariants);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteInvariant(id) {
    setIsBusy(true);
    setError("");
    try {
      const state = await apiRequest(`/api/day14/invariants/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setInvariants(state.invariants);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!message.trim() || isBusy) return;
    setIsBusy(true);
    setError("");
    try {
      setResult(await apiRequest("/api/day14/chat", {
        method: "POST",
        body: JSON.stringify({
          systemPrompt,
          message,
          model,
          maxTokens: Number(maxTokens),
          temperature: Number(temperature),
        }),
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div><p className="eyebrow">День 14</p><h2>Инварианты задачи</h2><p className="muted">Проверка выполняется до вызова модели, а ограничения хранятся отдельно в SQLite.</p></div>
        <span className={hasApiKey ? "status ready" : "status missing"}>{hasApiKey ? "Ключ готов" : "Нет ключа"}</span>
      </div>
      {!hasApiKey && <div className="notice">Для допустимого запроса нужен ключ OpenRouter. Конфликтный запрос можно проверить без ключа.<button className="text-button" onClick={onOpenSettings} type="button">Открыть настройки</button></div>}
      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <section className="invariant-panel">
        <div className="result-heading"><div><p className="eyebrow">Отдельное хранилище</p><h3>Активные инварианты · {invariants.length}</h3></div></div>
        <div className="invariant-list">
          {invariants.map((invariant) => (
            <article className="invariant-card" key={invariant.id}>
              <div><span className="memory-layer-label">{invariant.category}</span><p>{invariant.rule}</p><small>Триггеры: {invariant.forbiddenTerms.join(", ")}</small></div>
              <button className="text-button" disabled={isBusy} onClick={() => deleteInvariant(invariant.id)} type="button">Удалить</button>
            </article>
          ))}
        </div>
        <form className="invariant-editor" onSubmit={addInvariant}>
          <label>Категория<input disabled={isBusy} onChange={(event) => setCategory(event.target.value)} value={category} /></label>
          <label>Правило<input disabled={isBusy} onChange={(event) => setRule(event.target.value)} value={rule} /></label>
          <label>Запрещённые термины через запятую<input disabled={isBusy} onChange={(event) => setTerms(event.target.value)} value={terms} /></label>
          <button className="secondary-button" disabled={isBusy} type="submit">Добавить инвариант</button>
        </form>
      </section>

      <form className="experiment-form" onSubmit={sendMessage}>
        <label>Системная инструкция<textarea disabled={isBusy} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" value={systemPrompt} /></label>
        <div className="button-row invariant-examples">
          <span className="field-hint">Подставь готовый сценарий проверки:</span>
          <button className="secondary-button" disabled={isBusy} onClick={() => setMessage(DAY14_CONFLICT_PROMPT)} type="button">Конфликт</button>
          <button className="secondary-button" disabled={isBusy} onClick={() => setMessage(DAY14_SAFE_PROMPT)} type="button">Допустимый запрос</button>
        </div>
        <label>Запрос пользователя<textarea disabled={isBusy} onChange={(event) => setMessage(event.target.value)} rows="5" value={message} /></label>
        <div className="day11-settings-grid">
          <label>Модель OpenRouter<input disabled={isBusy} onChange={(event) => setModel(event.target.value)} value={model} /></label>
          <label>Максимум ответа<input disabled={isBusy} min="1" max="8192" onChange={(event) => setMaxTokens(event.target.value)} type="number" value={maxTokens} /></label>
          <label>Temperature<input disabled={isBusy} min="0" max="2" step="0.1" onChange={(event) => setTemperature(event.target.value)} type="number" value={temperature} /></label>
        </div>
        <button className="primary-button" disabled={isBusy || !message.trim()} type="submit">{isBusy ? "Проверяю…" : "Проверить запрос"}</button>
      </form>

      {error && <p className="error-message result-message">{error}</p>}
      {result && (
        <section className={result.blocked ? "result-card invariant-blocked" : "result-card invariant-allowed"}>
          <div className="result-heading"><div><p className="eyebrow">Решение агента</p><h3>{result.blocked ? "Запрос отклонён до вызова LLM" : "Запрос разрешён"}</h3></div><span className={result.blocked ? "status missing" : "status ready"}>{result.blocked ? "Конфликт" : "Разрешено"}</span></div>
          <div className="markdown-body"><MarkdownContent>{result.answer}</MarkdownContent></div>
          {result.conflicts.length > 0 && <ul className="conflict-list">{result.conflicts.map(({ invariant, matchedTerms }) => <li key={invariant.id}><strong>{invariant.category}:</strong> {invariant.rule}<br /><small>Найдены термины: {matchedTerms.join(", ")}</small></li>)}</ul>}
          {result.response && <><ResultMetrics result={result.response} /><RequestDetails request={result.response.httpRequest} title="Технические детали запроса с инвариантами" /></>}
        </section>
      )}
    </section>
  );
}
