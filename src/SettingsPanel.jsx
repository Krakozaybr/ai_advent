import { useState } from "react";
import { apiRequest } from "./api.js";

const sourceLabels = {
  environment: "Ключ загружен из .env",
  saved: "Ключ сохранён локально",
};

export function SettingsPanel({ status, onClose, onSaved }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const nextStatus = await apiRequest("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      });
      setApiKey("");
      onSaved(nextStatus);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-panel" aria-label="Настройки OpenRouter">
      <div>
        <p className="eyebrow">Настройки</p>
        <h2>Ключ OpenRouter</h2>
        <p className="muted">
          {status.hasApiKey ? sourceLabels[status.source] : "Ключ пока не задан"}. Сохранённый ключ
          лежит только в локальном <code>data/settings.json</code> и не возвращается в браузер.
        </p>
      </div>
      <form className="settings-form" onSubmit={save}>
        <label>
          Новый API-ключ
          <input
            autoComplete="off"
            name="apiKey"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-or-v1-…"
            type="password"
            value={apiKey}
          />
        </label>
        {error && <p className="error-message">{error}</p>}
        <div className="button-row">
          <button className="secondary-button" onClick={onClose} type="button">
            Закрыть
          </button>
          <button className="primary-button" disabled={saving || !apiKey.trim()} type="submit">
            {saving ? "Сохраняю…" : "Сохранить ключ"}
          </button>
        </div>
      </form>
    </section>
  );
}
