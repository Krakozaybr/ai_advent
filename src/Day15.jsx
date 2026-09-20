import { useEffect, useState } from "react";
import {
  DAY15_GUARDS,
  DAY15_STATE_LABELS,
  DAY15_STATES,
  DAY15_TRANSITIONS,
} from "../shared/day15.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";

const ASSIGNMENT = `Реализуйте явные переходы между состояниями задачи.

- задайте допустимые состояния и переходы;
- запретите перепрыгивать этапы;
- запретите реализацию без утверждённого плана и завершение без проверки;
- проверьте недопустимые переходы и продолжение после паузы.

**Результат:** ассистент с контролируемым жизненным циклом задачи.`;

export function Day15() {
  const [lifecycle, setLifecycle] = useState(null);
  const [events, setEvents] = useState([]);
  const [lastAction, setLastAction] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  function applyState(state) {
    setLifecycle(state.lifecycle);
    setEvents(state.events ?? []);
    if (typeof state.ok === "boolean") {
      setLastAction({ ok: state.ok, reason: state.reason });
    }
  }

  useEffect(() => {
    apiRequest("/api/day15/state")
      .then(applyState)
      .catch((requestError) => setError(requestError.message));
  }, []);

  async function updateGuard(guard, value) {
    setIsBusy(true);
    setError("");
    try {
      applyState(await apiRequest(`/api/day15/guards/${guard}`, {
        method: "PATCH",
        body: JSON.stringify({ value }),
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function runAction(action, target) {
    setIsBusy(true);
    setError("");
    try {
      const state = await apiRequest("/api/day15/action", {
        method: "POST",
        body: JSON.stringify({ action, ...(target ? { target } : {}) }),
      });
      applyState(state);
      if (action === "reset") setLastAction(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsBusy(false);
    }
  }

  const nextTransition = lifecycle ? DAY15_TRANSITIONS[lifecycle.state] : null;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div><p className="eyebrow">День 15</p><h2>Контролируемые переходы</h2><p className="muted">Правила переходов проверяет код, а SQLite сохраняет состояние и каждую попытку.</p></div>
        <span className="status ready">Без вызова LLM</span>
      </div>
      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      {lifecycle && (
        <>
          <div className="task-phase-track">
            {DAY15_STATES.map((state, index) => {
              const currentIndex = DAY15_STATES.indexOf(lifecycle.state);
              return <div className={index < currentIndex ? "task-phase complete" : index === currentIndex ? "task-phase active" : "task-phase"} key={state}><span>{index + 1}</span><strong>{DAY15_STATE_LABELS[state]}</strong></div>;
            })}
          </div>

          <section className={lifecycle.paused ? "task-state-card paused" : "task-state-card"}>
            <div className="task-state-heading"><div><p className="eyebrow">Текущее состояние</p><h3>{DAY15_STATE_LABELS[lifecycle.state]}</h3><p className="muted lifecycle-title">{lifecycle.title}</p></div><span className={lifecycle.paused ? "status missing" : "status ready"}>{lifecycle.paused ? "Пауза" : "Активна"}</span></div>
            <p className="lifecycle-next">{nextTransition ? <>Разрешённый следующий переход: <strong>{lifecycle.state} → {nextTransition.target}</strong></> : <strong>Жизненный цикл завершён.</strong>}</p>
            <div className="button-row memory-actions">
              <button className="secondary-button" disabled={isBusy} onClick={() => runAction("reset")} type="button">Начать заново</button>
              <button className="secondary-button" disabled={isBusy || lifecycle.state === "done"} onClick={() => runAction(lifecycle.paused ? "resume" : "pause")} type="button">{lifecycle.paused ? "Продолжить" : "Поставить на паузу"}</button>
            </div>
          </section>

          <section className="lifecycle-guards">
            <div><p className="eyebrow">Условия переходов</p><h3>Guard-условия</h3><p className="muted">Отметь условие только после того, как соответствующая работа действительно выполнена.</p></div>
            <div className="guard-grid">
              {Object.entries(DAY15_GUARDS).map(([guard, details]) => (
                <label className={lifecycle.guards[guard] ? "guard-card checked" : "guard-card"} key={guard}>
                  <input checked={lifecycle.guards[guard]} disabled={isBusy} onChange={(event) => updateGuard(guard, event.target.checked)} type="checkbox" />
                  <span><strong>{details.label}</strong><small>{details.description}</small></span>
                </label>
              ))}
            </div>
          </section>

          <section className="lifecycle-transitions">
            <div><p className="eyebrow">Проверка автомата</p><h3>Попытаться перейти в состояние</h3><p className="muted">Все кнопки доступны намеренно: попробуй перепрыгнуть этап или перейти без нужного условия.</p></div>
            <div className="transition-buttons">
              {DAY15_STATES.map((target) => <button className="secondary-button" disabled={isBusy} key={target} onClick={() => runAction("transition", target)} type="button">{DAY15_STATE_LABELS[target]}</button>)}
            </div>
          </section>
        </>
      )}

      {lastAction && <div className={lastAction.ok ? "transition-result accepted" : "transition-result rejected"}><strong>{lastAction.ok ? "Переход принят" : "Переход отклонён"}</strong><p>{lastAction.reason}</p></div>}
      {error && <p className="error-message result-message">{error}</p>}

      <details className="agent-architecture task-events" open>
        <summary>Журнал переходов · {events.length}</summary>
        {events.length === 0 ? <p>Попыток пока нет.</p> : <ol>{events.map((event) => <li className={event.accepted ? "event-accepted" : "event-rejected"} key={event.id}><strong>{event.accepted ? "Принято" : "Отклонено"}</strong> — {event.details}</li>)}</ol>}
      </details>
    </section>
  );
}
