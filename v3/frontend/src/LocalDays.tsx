import { FormEvent, useEffect, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

type Source = { title: string; source: string; section: string; chunk_id: string; quote: string };
type Answer = { answer: string; sources: Source[]; model: string; endpoint: string; localOnly: boolean; elapsedMs: number; abstained: boolean; embeddingModel?: string; profile?: string; settings?: { temperature: number; contextWindow: number; jsonMaxTokens: number }; metrics: Array<{ operation: string; tokensPerSecond: number | null }> };
type Turn = { question: string; result: Answer };
type Status = { version: string; endpoint: string; model: string; localOnly: boolean; models: Array<{ name: string; size: number }> };
const probes = ["Сколько будет 2 + 2? Ответь одним числом.", "Объясни в двух предложениях разницу между индексом документов и поиском по нему.", "Книг 48. Треть отдали в первую библиотеку, половину оставшихся — во вторую. Сколько осталось? Покажи короткий расчёт."];
const titles = { 26: "Запуск локальной LLM", 27: "Локальная LLM в приложении", 28: "Локальная LLM + RAG", 29: "Оптимизация локальной модели" };

async function localApi<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = await response.json().catch(() => { throw new Error("Сервер приложения недоступен. Запусти npm run local:backend."); });
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}

export function LocalDays({ initialDay = 26 }: { initialDay?: 26 | 27 | 28 | 29 }) {
  const [day, setDay] = useState<26 | 27 | 28 | 29>(initialDay);
  const [profile, setProfile] = useState("optimized");
  const [status, setStatus] = useState<Status | null>(null);
  const [question, setQuestion] = useState(initialDay >= 28 ? "Для чего Денис Григорьев отвинчивал гайки в рассказе «Злоумышленник»?" : probes[0]);
  const [turns, setTurns] = useState<Record<number, Turn[]>>({ 26: [], 27: [], 28: [], 29: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => { try { setStatus(await localApi<Status>("/api/local-llm/status")); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Ollama недоступен"); } };
  useEffect(() => { void refresh(); }, []);
  const select = (next: 26 | 27 | 28 | 29) => { setDay(next); setQuestion(next >= 28 ? "Для чего Денис Григорьев отвинчивал гайки в рассказе «Злоумышленник»?" : probes[0]); window.history.replaceState(null, "", `?localDay=${next}`); };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !question.trim()) return;
    const submitted = question;
    setBusy(true); setError("");
    try {
      const history = (day === 29 ? [] : turns[day].slice(-5)).flatMap((turn) => [{ role: "user", content: turn.question }, { role: "assistant", content: turn.result.answer }]);
      const result = await localApi<Answer>("/api/local-llm/chat", { question: submitted, rag: day >= 28, history, profile: day === 29 ? profile : "baseline" });
      setTurns((previous) => ({ ...previous, [day]: [...previous[day], { question: submitted, result }] }));
      setQuestion("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ошибка запроса"); }
    finally { setBusy(false); }
  };
  return <main className="local-days">
    <header><a href="/">← Доски</a><h1>Локальные модели</h1><p>Браузер → сервер приложения → Ollama на этом компьютере. API-ключ не нужен; облачного переключения при ошибке нет.</p></header>
    <nav aria-label="Локальные дни">{([26, 27, 28, 29] as const).map((number) => <button type="button" key={number} disabled={busy} aria-current={day === number ? "page" : undefined} onClick={() => select(number)}>День {number} · {titles[number]}</button>)}</nav>
    <section className="local-status"><button type="button" onClick={() => void refresh()} disabled={busy}>Проверить подключение</button>{status && <p>Ollama {status.version} · {status.endpoint} · {status.model}<br />Установлены: {status.models.map((model) => model.name).join(", ") || "моделей пока нет"}</p>}</section>
    <h2>День {day}. {titles[day]}</h2>
    {day === 29 && <section><p>Сравнение на одинаковых вопросах: <code>npm run local -- optimize</code>. Отчёт скорости, памяти и ответов: <code>npm run local -- report 29 --details</code>. Вопросы здесь независимы, без истории предыдущих ответов.</p><label>Настройки <select value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy}><option value="baseline">До оптимизации</option><option value="optimized">После оптимизации</option></select></label></section>}
    {day === 26 && <div className="local-probes">{probes.map((probe, number) => <button type="button" key={probe} disabled={busy} onClick={() => setQuestion(probe)}>{["Простой", "Средний", "Сложный"][number]} запрос</button>)}</div>}
    {day === 28 && <p>32 произведения из прежнего корпуса; отдельный индекс с локальными эмбеддингами. Подготовка: <code>npm run local -- index</code>. Сравнение и повторные запросы: <code>npm run local -- benchmark</code>. Цитаты проверяются на дословность; соответствие вывода цитатам нужно проверять отдельно.</p>}
    <div aria-live="polite">{turns[day].map((turn, number) => <article className="local-turn" key={number}>
      <h3>{turn.question}</h3><p>{turn.result.model} · {turn.result.elapsedMs} мс · Только локально: {turn.result.localOnly ? "да" : "нет"}{turn.result.embeddingModel && ` · Эмбеддинги: ${turn.result.embeddingModel}`}</p>
      {day === 29 && turn.result.settings && <p>{turn.result.profile} · temperature={turn.result.settings.temperature} · контекст={turn.result.settings.contextWindow} · лимит ответа={turn.result.settings.jsonMaxTokens}</p>}
      <MarkdownContent content={turn.result.answer} />
      {turn.result.sources.map((source, index) => <blockquote key={`${source.chunk_id}-${index}`}><p>{source.quote}</p><footer>{source.title} · {source.section} · {source.chunk_id}<br />{source.source}</footer></blockquote>)}
      {day === 28 && !turn.result.sources.length && <p>Источники не получены. Отказ: {turn.result.abstained ? "да" : "нет"}.</p>}
    </article>)}</div>
    <form onSubmit={(event) => void send(event)}><label htmlFor="local-question">Вопрос локальной модели</label><textarea id="local-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={6000} rows={4} disabled={busy} /><button type="submit" disabled={busy || !question.trim()}>{busy ? "Запрос выполняется…" : day === 28 ? "Ответить с локальным RAG" : "Отправить локально"}</button></form>
    {error && <p role="alert">{error}</p>}
  </main>;
}
