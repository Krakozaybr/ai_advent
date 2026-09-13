import { useEffect, useState } from "react";
import { days } from "./days.js";
import { apiRequest } from "./api.js";
import { Day1 } from "./Day1.jsx";
import { Day2 } from "./Day2.jsx";
import { Day3 } from "./Day3.jsx";
import { SettingsPanel } from "./SettingsPanel.jsx";

const DAY_COMPONENTS = { 1: Day1, 2: Day2, 3: Day3 };

export function App() {
  const [activeDayNumber, setActiveDayNumber] = useState(1);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState({ hasApiKey: false, source: null });

  useEffect(() => {
    apiRequest("/api/settings")
      .then(setSettingsStatus)
      .catch(() => setSettingsStatus({ hasApiKey: false, source: null }));
  }, []);

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">10 учебных экспериментов</p>
          <h1>AI Advent</h1>
          <p className="lead">От первого запроса к стратегиям управления контекстом.</p>
        </div>
        <div className="header-actions">
          <span className="stage-badge">Готовы Дни 1–3</span>
          <button
            className="settings-button"
            onClick={() => setShowSettings((value) => !value)}
            type="button"
          >
            Настройки
          </button>
        </div>
      </header>

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={(status) => {
            setSettingsStatus(status);
            setShowSettings(false);
          }}
          status={settingsStatus}
        />
      )}

      <nav className="day-tabs" role="tablist" aria-label="Дни AI Advent">
        {days.map((day) => (
          <button
            className={day.number === activeDayNumber ? "day-tab active" : "day-tab"}
            key={day.number}
            onClick={() => setActiveDayNumber(day.number)}
            role="tab"
            type="button"
            aria-selected={day.number === activeDayNumber}
            aria-controls={`day-${day.number}-content`}
          >
            <span>День</span>
            <strong>{day.number}</strong>
          </button>
        ))}
      </nav>

      {days.map((day) => {
        const DayComponent = DAY_COMPONENTS[day.number];

        return (
          <section
            hidden={day.number !== activeDayNumber}
            id={`day-${day.number}-content`}
            key={day.number}
            role="tabpanel"
          >
            {DayComponent ? (
              <DayComponent
                hasApiKey={settingsStatus.hasApiKey}
                onOpenSettings={() => setShowSettings(true)}
              />
            ) : (
              <div className="day-card">
                <div className="day-number">{String(day.number).padStart(2, "0")}</div>
                <div className="day-copy">
                  <p className="eyebrow">День {day.number}</p>
                  <h2>{day.title}</h2>
                  <p>{day.description}</p>
                  <div className="placeholder">
                    <span className="placeholder-dot" aria-hidden="true" />
                    Содержимое появится на этапе Day {day.number}
                  </div>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
