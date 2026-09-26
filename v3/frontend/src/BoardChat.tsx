import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvent, emptyRunState, RunEvent, RunState } from "./run-state.mjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  runStatus?: string;
  runError?: string;
};

type Lane = {
  id: string;
  title: string;
  codexThreadId?: string;
  messages: Message[];
  activeRun: { id: string; sequence: number } | null;
};

type BoardResponse = {
  board: { id: string; title: string };
  lanes: Lane[];
};

type CodexStatus = {
  authenticated: boolean;
  planType?: string;
  error?: string;
};

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function BoardChat() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [message, setMessage] = useState("");
  const [runState, setRunState] = useState<RunState>(emptyRunState());
  const [runId, setRunId] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const refreshBoard = useCallback(async () => {
    const value = await readJson<BoardResponse>("/api/board");
    setBoard(value);
    return value;
  }, []);

  const refreshCodex = useCallback(async () => {
    try {
      setCodex(await readJson<CodexStatus>("/api/codex/status"));
    } catch (cause) {
      setCodex({ authenticated: false, error: cause instanceof Error ? cause.message : "Codex недоступен" });
    }
  }, []);

  useEffect(() => {
    void Promise.all([refreshBoard(), refreshCodex()]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить доску");
    });
    return () => sourceRef.current?.close();
  }, [refreshBoard, refreshCodex]);

  const listenToRun = useCallback((id: string, after: number) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/runs/${id}/events?after=${after}`);
    sourceRef.current = source;
    const onEvent = (event: Event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as RunEvent;
      setRunState((current) => applyRunEvent(current, data));
      if (data.type === "run.completed" || data.type === "run.failed") {
        source.close();
        if (sourceRef.current === source) sourceRef.current = null;
        setRunId(null);
        void refreshBoard();
      }
    };
    source.onmessage = onEvent;
    source.onerror = () => {
      // EventSource reconnects with Last-Event-ID; the server replays saved events.
    };
  }, [refreshBoard]);

  useEffect(() => {
    const lane = board?.lanes[0];
    if (lane?.activeRun && !runId) {
      setRunId(lane.activeRun.id);
      setRunState({
        sequence: lane.activeRun.sequence,
        status: "running",
        answer: lane.messages.find((item) => item.role === "assistant" && item.runStatus === "running")?.content ?? "",
        error: null,
      });
      listenToRun(lane.activeRun.id, lane.activeRun.sequence);
    }
  }, [board, listenToRun, runId]);

  useEffect(() => {
    if (!authUrl || codex?.authenticated) return;
    const timer = window.setInterval(() => void refreshCodex(), 2_000);
    return () => window.clearInterval(timer);
  }, [authUrl, codex?.authenticated, refreshCodex]);

  const lane = board?.lanes[0];
  const isRunning = runState.status === "running" || Boolean(lane?.activeRun);

  async function startLogin() {
    setError(null);
    try {
      const result = await readJson<{ authUrl: string }>("/api/codex/login", { method: "POST" });
      setAuthUrl(result.authUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось начать вход");
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lane || !message.trim() || isRunning) return;
    setError(null);
    const text = message.trim();
    setMessage("");
    setRunState(emptyRunState());
    try {
      const result = await readJson<{ runId: string }>(`/api/lanes/${lane.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setRunId(result.runId);
      const updated = await refreshBoard();
      const active = updated.lanes[0]?.activeRun;
      const savedAnswer = updated.lanes[0]?.messages.find(
        (item) => item.role === "assistant" && item.runStatus === "running",
      )?.content ?? "";
      const sequence = active?.sequence ?? 0;
      setRunState({ sequence, status: "running", answer: savedAnswer, error: null });
      listenToRun(result.runId, sequence);
    } catch (cause) {
      setMessage(text);
      setRunState({ ...emptyRunState(), status: "failed", error: cause instanceof Error ? cause.message : "Ошибка запроса" });
      await refreshBoard();
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="AI Advent v3">
          <span className="mark">A</span>
          <span>AI Advent <small>v3</small></span>
        </a>
        <div className="connection">
          <span className={`status-dot ${codex?.authenticated ? "online" : "offline"}`} />
          <span>{codex?.authenticated ? `Codex · ${codex.planType ?? "ChatGPT"}` : "Codex не подключён"}</span>
        </div>
      </header>

      <section className="conversation" id="top">
        <div className="intro">
          <p className="eyebrow">ОДНА ДОСКА · ОДНА ЛЕНТА</p>
          <h1>{board?.board.title ?? "AI Advent"}</h1>
          <p className="subheading">Начни диалог с Codex. История хранится локально на этом устройстве.</p>
        </div>

        {!codex?.authenticated && (
          <div className="connect-card">
            <div>
              <strong>Войди через подписку ChatGPT</strong>
              <p>Подключение использует локальный Codex. Ключ OpenAI API не нужен.</p>
            </div>
            {authUrl ? (
              <a className="button secondary" href={authUrl} target="_blank" rel="noreferrer">Открыть вход</a>
            ) : (
              <button className="button secondary" onClick={() => void startLogin()}>Войти в ChatGPT</button>
            )}
          </div>
        )}

        <div className="messages" aria-live="polite">
          {lane?.messages.filter((item) => !(item.role === "assistant" && item.runStatus === "running")).map((item) => (
            <article className={`message ${item.role}`} key={item.id}>
              <div className="message-label">{item.role === "user" ? "ТЫ" : "CODEX"}</div>
              <div className="message-content">{item.content || (item.runStatus === "running" ? "Пишет…" : "")}</div>
              {item.runStatus === "failed" && <p className="message-error">{item.runError ?? "Ответ не завершён."}</p>}
            </article>
          ))}
          {runId && runState.status === "running" && runState.answer && (
            <article className="message assistant streaming" aria-label="Ответ Codex поступает">
              <div className="message-label">CODEX · ОТВЕТ</div>
              <div className="message-content">{runState.answer}<span className="cursor" /></div>
            </article>
          )}
          {lane?.messages.length === 0 && !isRunning && (
            <div className="empty-state">
              <span className="empty-symbol">✳</span>
              <p>Напиши первый вопрос</p>
              <span>Ответ появится здесь по мере поступления.</span>
            </div>
          )}
        </div>

        {error && <p className="error-banner" role="alert">{error}</p>}
        {runState.status === "failed" && runState.error && (
          <p className="error-banner" role="alert">{runState.error}</p>
        )}

        <form className="composer" onSubmit={(event) => void sendMessage(event)}>
          <textarea
            aria-label="Сообщение для Codex"
            placeholder={codex?.authenticated ? "Напиши сообщение…" : "Сначала войди через ChatGPT"}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={3}
            disabled={!codex?.authenticated || isRunning}
          />
          <div className="composer-footer">
            <span>{isRunning ? "Запрос выполняется · в ленте только один активный запрос" : "Enter — отправить · Shift+Enter — новая строка"}</span>
            <button className="button primary" type="submit" disabled={!codex?.authenticated || isRunning || !message.trim()}>
              {isRunning ? "Отвечает…" : "Отправить"}
              {!isRunning && <span aria-hidden="true">↗</span>}
            </button>
          </div>
        </form>
      </section>

      <footer className="footer">История остаётся в локальном файле SQLite · Codex через подписку ChatGPT</footer>
    </main>
  );
}
