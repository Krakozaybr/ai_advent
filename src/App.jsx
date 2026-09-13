import { useState } from "react";
import { days } from "./days.js";

export function App() {
  const [activeDayNumber, setActiveDayNumber] = useState(1);
  const activeDay = days.find((day) => day.number === activeDayNumber);

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">10 учебных экспериментов</p>
          <h1>AI Advent</h1>
          <p className="lead">От первого запроса к стратегиям управления контекстом.</p>
        </div>
        <span className="stage-badge">Этап 0 · каркас</span>
      </header>

      <nav className="day-tabs" role="tablist" aria-label="Дни AI Advent">
        {days.map((day) => (
          <button
            className={day.number === activeDayNumber ? "day-tab active" : "day-tab"}
            key={day.number}
            onClick={() => setActiveDayNumber(day.number)}
            role="tab"
            type="button"
            aria-selected={day.number === activeDayNumber}
            aria-controls="day-content"
          >
            <span>День</span>
            <strong>{day.number}</strong>
          </button>
        ))}
      </nav>

      <section className="day-card" id="day-content" role="tabpanel">
        <div className="day-number">{String(activeDay.number).padStart(2, "0")}</div>
        <div className="day-copy">
          <p className="eyebrow">День {activeDay.number}</p>
          <h2>{activeDay.title}</h2>
          <p>{activeDay.description}</p>
          <div className="placeholder">
            <span className="placeholder-dot" aria-hidden="true" />
            Содержимое появится на этапе Day {activeDay.number}
          </div>
        </div>
      </section>
    </main>
  );
}
