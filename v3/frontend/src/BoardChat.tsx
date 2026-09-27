import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvent, emptyRunState, RunEvent, RunState } from "./run-state.mjs";
import { chooseBoardId } from "./workspace-state.mjs";
import { describeLaneOrigin } from "./lane-lineage.mjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  runStatus?: string;
  runError?: string;
  hasBranches?: boolean;
};

type Lane = {
  id: string;
  title: string;
  messages: Message[];
  activeRun: { id: string; sequence: number } | null;
  originKind?: "branch" | "clone";
  originLaneId?: string;
  originMessage?: Message;
};

type BoardSummary = { id: string; title: string };
type BoardResponse = { board: BoardSummary; lanes: Lane[] };
type CodexStatus = { authenticated: boolean; planType?: string; error?: string };

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function BoardChat() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshBoard = useCallback(async (boardId: string) => {
    const value = await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(boardId)}`);
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

  const refreshBoards = useCallback(async () => {
    const result = await readJson<{ boards: BoardSummary[] }>("/api/boards");
    setBoards(result.boards);
    const saved = window.localStorage.getItem("workspace.activeBoardId");
    const selected = chooseBoardId(saved, result.boards);
    setActiveBoardId(selected);
    if (selected) {
      window.localStorage.setItem("workspace.activeBoardId", selected);
      await refreshBoard(selected);
    }
  }, [refreshBoard]);

  useEffect(() => {
    void Promise.all([refreshBoards(), refreshCodex()]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить доски");
    });
  }, [refreshBoards, refreshCodex]);

  useEffect(() => {
    if (!authUrl || codex?.authenticated) return;
    const timer = window.setInterval(() => void refreshCodex(), 2_000);
    return () => window.clearInterval(timer);
  }, [authUrl, codex?.authenticated, refreshCodex]);

  async function selectBoard(boardId: string) {
    setActiveBoardId(boardId);
    window.localStorage.setItem("workspace.activeBoardId", boardId);
    setError(null);
    try {
      await refreshBoard(boardId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть доску");
    }
  }

  async function createBoard() {
    setError(null);
    try {
      const created = await readJson<BoardResponse>("/api/boards", { method: "POST" });
      setBoards((current) => [...current, created.board]);
      await selectBoard(created.board.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать доску");
    }
  }

  async function createLane() {
    if (!activeBoardId) return;
    setError(null);
    try {
      setBoard(await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(activeBoardId)}/lanes`, { method: "POST" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать ленту");
    }
  }

  async function createBranch(laneId: string, messageId: string) {
    if (!activeBoardId) return;
    setError(null);
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать ветку");
    }
  }

  async function cloneLane(laneId: string) {
    if (!activeBoardId) return;
    setError(null);
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/clone`, { method: "POST" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось клонировать ленту");
    }
  }

  async function startLogin() {
    setError(null);
    try {
      const result = await readJson<{ authUrl: string }>("/api/codex/login", { method: "POST" });
      setAuthUrl(result.authUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось начать вход");
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <nav className="board-tabs" aria-label="Доски">
          {boards.map((item) => (
            <button
              className={`board-tab ${item.id === activeBoardId ? "selected" : ""}`}
              key={item.id}
              onClick={() => void selectBoard(item.id)}
              aria-current={item.id === activeBoardId ? "page" : undefined}
            >
              {item.title}
            </button>
          ))}
          <button className="add-board" aria-label="Создать доску" title="Создать доску" onClick={() => void createBoard()}>＋</button>
        </nav>
        <div className="connection" title={codex?.error}>
          <span className={`status-dot ${codex?.authenticated ? "online" : "offline"}`} />
          <span>{codex?.authenticated ? `Codex · ${codex.planType ?? "ChatGPT"}` : "Codex не подключён"}</span>
          {!codex?.authenticated && <button className="login-link" onClick={() => void startLogin()}>{authUrl ? "Открыть вход" : "Войти"}</button>}
          {authUrl && !codex?.authenticated && <a className="auth-link" href={authUrl} target="_blank" rel="noreferrer" aria-label="Открыть вход через ChatGPT">↗</a>}
        </div>
      </header>

      {!codex?.authenticated && (
        <div className="login-banner">
          <span>Войди через подписку ChatGPT, чтобы отправлять запросы через Codex.</span>
          <span>Ключ API не нужен.</span>
        </div>
      )}

      <section className="canvas" aria-label="Рабочая область доски">
        {error && <p className="error-banner" role="alert">{error}</p>}
        {board && board.board.id === activeBoardId ? (
          <div className="lanes" key={board.board.id}>
            {board.lanes.map((lane) => (
              <LaneView
                key={lane.id}
                lane={lane}
                authenticated={Boolean(codex?.authenticated)}
                onRefresh={() => refreshBoard(board.board.id)}
                onBranch={(messageId) => void createBranch(lane.id, messageId)}
                onClone={() => void cloneLane(lane.id)}
              />
            ))}
            <button className="new-lane" onClick={() => void createLane()}><span>＋</span> Добавить ленту</button>
          </div>
        ) : <div className="loading">Открываю доску…</div>}
      </section>
    </main>
  );
}

function LaneView({ lane, authenticated, onRefresh, onBranch, onClone }: {
  lane: Lane;
  authenticated: boolean;
  onRefresh: () => Promise<BoardResponse>;
  onBranch: (messageId: string) => void;
  onClone: () => void;
}) {
  const [message, setMessage] = useState("");
  const [runState, setRunState] = useState<RunState>(emptyRunState());
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const listenToRun = useCallback((id: string, after: number) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/runs/${id}/events?after=${after}`);
    sourceRef.current = source;
    source.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as RunEvent;
      setRunState((current) => applyRunEvent(current, data));
      if (data.type === "run.completed" || data.type === "run.failed") {
        source.close();
        if (sourceRef.current === source) sourceRef.current = null;
        setRunId(null);
        void onRefresh();
      }
    };
  }, [onRefresh]);

  useEffect(() => {
    if (!lane.activeRun || runId === lane.activeRun.id) return;
    setRunId(lane.activeRun.id);
    setRunState({
      sequence: lane.activeRun.sequence,
      status: "running",
      answer: lane.messages.find((item) => item.role === "assistant" && item.runStatus === "running")?.content ?? "",
      error: null,
    });
    listenToRun(lane.activeRun.id, lane.activeRun.sequence);
  }, [lane.activeRun?.id, lane.activeRun?.sequence, lane.messages, listenToRun, runId]);

  useEffect(() => () => sourceRef.current?.close(), []);

  function resizeTextarea(element: HTMLTextAreaElement) {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || lane.activeRun || runState.status === "running") return;
    setError(null);
    const text = message.trim();
    setMessage("");
    if (textareaRef.current) resizeTextarea(textareaRef.current);
    setRunState(emptyRunState());
    try {
      const result = await readJson<{ runId: string }>(`/api/lanes/${lane.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setRunId(result.runId);
      const updated = await onRefresh();
      const latestLane = updated.lanes.find((item) => item.id === lane.id);
      const active = latestLane?.activeRun;
      const savedAnswer = latestLane?.messages.find((item) => item.role === "assistant" && item.runStatus === "running")?.content ?? "";
      const sequence = active?.sequence ?? 0;
      setRunState({ sequence, status: "running", answer: savedAnswer, error: null });
      listenToRun(result.runId, sequence);
    } catch (cause) {
      setMessage(text);
      setRunState({ ...emptyRunState(), status: "failed", error: cause instanceof Error ? cause.message : "Ошибка запроса" });
      setError(cause instanceof Error ? cause.message : "Ошибка запроса");
    }
  }

  const running = Boolean(lane.activeRun) || runState.status === "running";

  return (
    <article className="lane">
      <div className="lane-heading"><span className="lane-dot" /><h2>{lane.title}</h2><span className="lane-provider">CODEX</span><button className="lane-clone" type="button" onClick={onClone} disabled={running}>Клон</button></div>
      {lane.originKind && (
        <div className={`lane-origin ${lane.originKind}`}>
          <span aria-hidden="true">↳</span>
          <span>{describeLaneOrigin(lane.originKind, lane.originMessage?.content).label}</span>
          {lane.originMessage?.content && <q>{describeLaneOrigin(lane.originKind, lane.originMessage.content).excerpt}</q>}
        </div>
      )}
      <div className="lane-messages" aria-live="polite">
        {lane.messages.filter((item) => !(item.role === "assistant" && item.runStatus === "running")).map((item) => (
          <article className={`message ${item.role}`} key={item.id}>
            <div className="message-label">{item.role === "user" ? "ТЫ" : "CODEX"}</div>
            <div className="message-content">{item.content}</div>
            {item.runStatus === "failed" && <p className="message-error">{item.runError ?? "Ответ не завершён."}</p>}
            <div className="message-actions">
              {item.hasBranches && <span className="branch-existing">Есть ветка</span>}
              <button type="button" onClick={() => onBranch(item.id)} disabled={running}>Ответвиться здесь</button>
            </div>
          </article>
        ))}
        {runId && runState.status === "running" && runState.answer && (
          <article className="message assistant streaming" aria-label="Ответ Codex поступает">
            <div className="message-label">CODEX · ОТВЕТ</div>
            <div className="message-content">{runState.answer}<span className="cursor" /></div>
          </article>
        )}
        {lane.messages.length === 0 && !running && <div className="empty-state"><span className="empty-symbol">✳</span><p>Новый диалог</p><span>Напиши запрос внизу ленты.</span></div>}
      </div>
      {error && <p className="lane-error" role="alert">{error}</p>}
      {runState.status === "failed" && runState.error && !error && <p className="lane-error" role="alert">{runState.error}</p>}
      <form className="composer" onSubmit={(event) => void sendMessage(event)}>
        <textarea
          ref={textareaRef}
          aria-label={`Сообщение для ${lane.title}`}
          placeholder={authenticated ? "Напиши сообщение…" : "Войди в Codex, чтобы отправить запрос"}
          value={message}
          onChange={(event) => { setMessage(event.target.value); resizeTextarea(event.currentTarget); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          disabled={!authenticated || running}
        />
        <div className="composer-footer">
          <span>{running ? "Запрос выполняется" : "Enter — отправить · Shift+Enter — новая строка"}</span>
          <button className="button primary" type="submit" disabled={!authenticated || running || !message.trim()} aria-label="Отправить сообщение">
            ↗
          </button>
        </div>
      </form>
    </article>
  );
}
