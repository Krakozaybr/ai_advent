import { useEffect, useState } from "react";
import {
  DAY13_DEFAULT_PROMPT,
  DAY13_PHASE_LABELS,
  DAY13_PHASES,
  DEFAULT_DAY13_SYSTEM_PROMPT,
} from "../shared/day13.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Реализуйте состояние задачи как конечный автомат:

- этап задачи;
- текущий шаг;
- ожидаемое действие;
- состояния planning → execution → validation → done.

Проверьте паузу на любом этапе и продолжение без повторных объяснений.

**Результат:** агент с формализованным состоянием задачи.`;

function ChatMessage({ item }) {
  return (
    <div className={`chat-message ${item.role === "user" ? "user-message" : "assistant-message"}`}>
      <span className="chat-role">{item.role === "user" ? "User" : "Assistant"}</span>
      {item.role === "assistant" ? <div className="markdown-body"><MarkdownContent>{item.content}</MarkdownContent></div> : <p>{item.content}</p>}
    </div>
  );
}

export function Day13({ hasApiKey, onOpenSettings }) {
  const [task, setTask] = useState(null);
  const [events, setEvents] = useState([]);
  const [messages, setMessages] = useState([]);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY13_SYSTEM_PROMPT);
  const [message, setMessage] = useState(DAY13_DEFAULT_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(400);
  const [temperature, setTemperature] = useState(0.2);
  const [result, setResult] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  function applyState(state) {
    setTask(state.task);
    setEvents(state.events);
    setMessages(state.messages ?? []);
  }

  useEffect(() => {
    apiRequest("/api/day13/state").then(applyState).catch((requestError) => setError(requestError.message));
  }, []);

  function updateTask(field, value) {
    setTask((current) => ({ ...current, [field]: value }));
  }

  async function saveTask() {
    if (!task || isBusy) return;
    setIsBusy(true);
    setError("");
    try {
      applyState(await apiRequest("/api/day13/task", { method: "PUT", body: JSON.stringify(task) }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function runAction(action) {
    setIsBusy(true);
    setError("");
    try {
      const state = await apiRequest("/api/day13/action", { method: "POST", body: JSON.stringify({ action }) });
      applyState(state);
      if (action === "reset") setResult(null);
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
      const nextResult = await apiRequest("/api/day13/chat", {
        method: "POST",
        body: JSON.stringify({ systemPrompt, message, model, maxTokens: Number(maxTokens), temperature: Number(temperature) }),
      });
      setResult(nextResult);
      applyState(nextResult.state);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  const phaseIndex = task ? DAY13_PHASES.indexOf(task.phase) : -1;

  return (
    <section className="experiment-card">
      <div className="experiment-heading"><div><p className="eyebrow">День 13</p><h2>Состояние задачи</h2><p className="muted">Этап, шаг и ожидаемое действие сохраняются в SQLite.</p></div><span className={hasApiKey ? "status ready" : "status missing"}>{hasApiKey ? "Ключ готов" : "Нет ключа"}</span></div>
      {!hasApiKey && <div className="notice">Для чата нужен ключ OpenRouter.<button className="text-button" onClick={onOpenSettings} type="button">Открыть настройки</button></div>}
      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      {task && (
        <>
          <div className="task-phase-track">
            {DAY13_PHASES.map((phase, index) => <div className={index < phaseIndex ? "task-phase complete" : index === phaseIndex ? "task-phase active" : "task-phase"} key={phase}><span>{index + 1}</span><strong>{DAY13_PHASE_LABELS[phase]}</strong></div>)}
          </div>

          <section className={task.paused ? "task-state-card paused" : "task-state-card"}>
            <div className="task-state-heading"><div><p className="eyebrow">Текущее состояние</p><h3>{DAY13_PHASE_LABELS[task.phase]}</h3></div><span className={task.paused ? "status missing" : "status ready"}>{task.paused ? "Пауза" : "Активна"}</span></div>
            <label>Задача<input disabled={isBusy} onChange={(event) => updateTask("title", event.target.value)} value={task.title} /></label>
            <div className="field-grid">
              <label>Текущий шаг<textarea disabled={isBusy} onChange={(event) => updateTask("currentStep", event.target.value)} rows="3" value={task.currentStep} /></label>
              <label>Ожидаемое действие<textarea disabled={isBusy} onChange={(event) => updateTask("expectedAction", event.target.value)} rows="3" value={task.expectedAction} /></label>
            </div>
            <div className="button-row memory-actions">
              <button className="secondary-button" disabled={isBusy} onClick={() => runAction("reset")} type="button">Начать заново</button>
              <button className="secondary-button" disabled={isBusy} onClick={saveTask} type="button">Сохранить шаг</button>
              <button className="secondary-button" disabled={isBusy || task.phase === "done"} onClick={() => runAction(task.paused ? "resume" : "pause")} type="button">{task.paused ? "Продолжить" : "Поставить на паузу"}</button>
              <button className="primary-button" disabled={isBusy || task.paused || task.phase === "done"} onClick={() => runAction("advance")} type="button">Следующий этап</button>
            </div>
          </section>
        </>
      )}

      <details className="agent-architecture task-events" open>
        <summary>История состояния · {events.length}</summary>
        {events.length === 0 ? <p>Событий пока нет.</p> : <ol>{events.map((event) => <li key={event.id}><strong>{event.eventType}</strong> — {event.details}</li>)}</ol>}
      </details>

      <div className="experiment-form agent-settings">
        <label>Системная инструкция<textarea disabled={isBusy} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" value={systemPrompt} /></label>
        <div className="day11-settings-grid"><label>Модель OpenRouter<input disabled={isBusy} onChange={(event) => setModel(event.target.value)} value={model} /></label><label>Максимум ответа<input disabled={isBusy} min="1" max="8192" onChange={(event) => setMaxTokens(event.target.value)} type="number" value={maxTokens} /></label><label>Temperature<input disabled={isBusy} min="0" max="2" step="0.1" onChange={(event) => setTemperature(event.target.value)} type="number" value={temperature} /></label></div>
      </div>

      <section className="chat-shell">
        <div className="chat-list">{messages.length === 0 && !isBusy && <p className="chat-empty">Диалог пуст. Состояние задачи уже будет передано агенту.</p>}{messages.map((item) => <ChatMessage item={item} key={item.id} />)}</div>
        <form className="chat-composer" onSubmit={sendMessage}><label>Сообщение агенту<textarea disabled={isBusy} onChange={(event) => setMessage(event.target.value)} rows="4" value={message} /></label><div className="button-row"><span className="field-hint">После перезапуска состояние и диалог восстановятся.</span><button className="primary-button" disabled={!hasApiKey || isBusy || !message.trim()} type="submit">{isBusy ? "Выполняю…" : "Отправить"}</button></div></form>
      </section>

      {error && <p className="error-message result-message">{error}</p>}
      {result && <section className="result-card"><ResultMetrics result={result.response} /><RequestDetails request={result.response.httpRequest} title="Технические детали запроса с состоянием задачи" /></section>}
    </section>
  );
}
