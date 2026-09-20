import { useEffect, useMemo, useState } from "react";
import {
  DAY12_DEFAULT_PROFILES,
  DAY12_DEFAULT_PROMPT,
  DEFAULT_DAY12_SYSTEM_PROMPT,
} from "../shared/day12.js";
import { DEFAULT_MODEL } from "../shared/models.js";
import { apiRequest } from "./api.js";
import { AssignmentDetails } from "./AssignmentDetails.jsx";
import { MarkdownContent } from "./MarkdownContent.jsx";
import { RequestDetails } from "./RequestDetails.jsx";
import { ResultMetrics } from "./ResultMetrics.jsx";

const ASSIGNMENT = `Добавьте персонализацию поверх модели памяти:

- создайте профиль пользователя;
- опишите предпочтения: стиль, формат и ограничения;
- подключайте профиль к каждому запросу.

Сравните ответы для разных профилей и проверьте, что ассистент учитывает их автоматически.

**Результат:** персонализированный агент, адаптированный под пользователя.`;

const PROFILE_FIELDS = [
  ["name", "Название"],
  ["expertise", "Уровень знаний"],
  ["style", "Стиль ответа"],
  ["format", "Формат ответа"],
  ["constraints", "Ограничения"],
  ["language", "Язык"],
];

function ProfileEditor({ disabled, onChange, profile }) {
  return (
    <div className="profile-editor">
      {PROFILE_FIELDS.map(([field, label]) => (
        <label key={field}>
          {label}
          {field === "name" || field === "language" ? (
            <input disabled={disabled} onChange={(event) => onChange(field, event.target.value)} value={profile[field]} />
          ) : (
            <textarea disabled={disabled} onChange={(event) => onChange(field, event.target.value)} rows="2" value={profile[field]} />
          )}
        </label>
      ))}
    </div>
  );
}

export function Day12({ hasApiKey, onOpenSettings }) {
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState("beginner");
  const [memory, setMemory] = useState({ messages: 0, items: 0 });
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_DAY12_SYSTEM_PROMPT);
  const [message, setMessage] = useState(DAY12_DEFAULT_PROMPT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [maxTokens, setMaxTokens] = useState(400);
  const [temperature, setTemperature] = useState(0.2);
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState("");

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId),
    [activeProfileId, profiles],
  );

  useEffect(() => {
    apiRequest("/api/day12/state")
      .then((state) => {
        setProfiles(state.profiles);
        setMemory(state.memory);
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setIsLoading(false));
  }, []);

  function updateProfile(field, value) {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === activeProfileId ? { ...profile, [field]: value } : profile,
      ),
    );
  }

  async function saveProfile() {
    if (!activeProfile || isSaving) return;
    setIsSaving(true);
    setError("");
    try {
      const saved = await apiRequest(`/api/day12/profiles/${activeProfile.id}`, {
        method: "PUT",
        body: JSON.stringify(activeProfile),
      });
      setProfiles((current) => current.map((profile) => (profile.id === saved.id ? saved : profile)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function resetProfiles() {
    setIsSaving(true);
    setError("");
    try {
      const saved = await Promise.all(
        DAY12_DEFAULT_PROFILES.map((profile) =>
          apiRequest(`/api/day12/profiles/${profile.id}`, {
            method: "PUT",
            body: JSON.stringify(profile),
          }),
        ),
      );
      setProfiles(saved);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function compare(event) {
    event.preventDefault();
    if (profiles.length !== 2 || !message.trim() || isRunning) return;
    setIsRunning(true);
    setError("");
    try {
      const nextResult = await apiRequest("/api/day12/compare", {
        method: "POST",
        body: JSON.stringify({
          profileIds: profiles.map((profile) => profile.id),
          systemPrompt,
          message,
          model,
          maxTokens: Number(maxTokens),
          temperature: Number(temperature),
        }),
      });
      setResult(nextResult);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsRunning(false);
    }
  }

  const disabled = isLoading || isSaving || isRunning;

  return (
    <section className="experiment-card">
      <div className="experiment-heading">
        <div>
          <p className="eyebrow">День 12</p>
          <h2>Персонализация ассистента</h2>
          <p className="muted">Одинаковая память, два профиля и два разных ответа.</p>
        </div>
        <span className={hasApiKey ? "status ready" : "status missing"}>{hasApiKey ? "Ключ готов" : "Нет ключа"}</span>
      </div>

      {!hasApiKey && <div className="notice">Для сравнения нужен ключ OpenRouter.<button className="text-button" onClick={onOpenSettings} type="button">Открыть настройки</button></div>}
      <AssignmentDetails>{ASSIGNMENT}</AssignmentDetails>

      <details className="agent-architecture" open>
        <summary>Что показать на видео</summary>
        <ol>
          <li>Переключи профили и покажи их стиль, формат и ограничения.</li>
          <li>Измени одно поле и сохрани профиль в SQLite.</li>
          <li>Отправь общий вопрос сразу для двух профилей.</li>
          <li>Сравни ответы и системные сообщения в технических деталях.</li>
        </ol>
      </details>

      <div className="agent-identity">
        <div><span className="agent-avatar" aria-hidden="true">P</span><div><strong>PersonalizedAgent</strong><p>Память Дня 11 подключается к обоим профилям</p></div></div>
        <span className="status ready">{memory.items} записей · {memory.messages} сообщ.</span>
      </div>

      <div className="variant-tabs" role="tablist" aria-label="Профили пользователя">
        {profiles.map((profile) => (
          <button className={profile.id === activeProfileId ? "variant-tab active" : "variant-tab"} disabled={disabled} key={profile.id} onClick={() => setActiveProfileId(profile.id)} role="tab" type="button">{profile.name}</button>
        ))}
      </div>

      {activeProfile && (
        <section className="variant-panel profile-panel">
          <ProfileEditor disabled={disabled} onChange={updateProfile} profile={activeProfile} />
          <div className="button-row memory-actions">
            <button className="secondary-button" disabled={disabled} onClick={resetProfiles} type="button">Вернуть два профиля</button>
            <button className="primary-button" disabled={disabled} onClick={saveProfile} type="button">{isSaving ? "Сохраняю…" : "Сохранить профиль"}</button>
          </div>
        </section>
      )}

      <form className="experiment-form day12-run-form" onSubmit={compare}>
        <label>Общий запрос<textarea disabled={isRunning} onChange={(event) => setMessage(event.target.value)} rows="4" value={message} /></label>
        <label>Системная инструкция<textarea disabled={isRunning} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" value={systemPrompt} /></label>
        <div className="day11-settings-grid">
          <label>Модель OpenRouter<input disabled={isRunning} onChange={(event) => setModel(event.target.value)} value={model} /></label>
          <label>Максимум ответа<input disabled={isRunning} max="8192" min="1" onChange={(event) => setMaxTokens(event.target.value)} type="number" value={maxTokens} /></label>
          <label>Temperature<input disabled={isRunning} max="2" min="0" onChange={(event) => setTemperature(event.target.value)} step="0.1" type="number" value={temperature} /></label>
        </div>
        <div className="button-row"><span className="field-hint">Профиль добавляется отдельным system message.</span><button className="primary-button" disabled={!hasApiKey || isRunning || profiles.length !== 2 || !message.trim()} type="submit">{isRunning ? "Сравниваю…" : "Сравнить профили"}</button></div>
      </form>

      {error && <p className="error-message result-message">{error}</p>}

      {result && (
        <section className="result-card">
          <p className="eyebrow">Результат</p>
          <div className="day11-answer-comparison">
            {result.runs.map((run) => (
              <article key={run.profile.id}>
                <h3>{run.profile.name}</h3>
                <div className="markdown-body"><MarkdownContent>{run.response.answer}</MarkdownContent></div>
                <ResultMetrics result={run.response} />
                <p className="field-hint">Контекст: {run.context.messages} сообщ., ≈ {run.context.estimatedInputTokens} токенов</p>
                <RequestDetails request={run.response.httpRequest} title={`Технические детали · ${run.profile.name}`} />
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
