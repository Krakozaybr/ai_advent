import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvent, emptyRunState, RunEvent, RunState } from "./run-state.mjs";
import { chooseBoardId } from "./workspace-state.mjs";
import { describeLaneOrigin } from "./lane-lineage.mjs";
import { MarkdownContent } from "./MarkdownContent";
import { getCanvasExtent, getCenteredScrollTarget } from "./canvas-layout.mjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  runStatus?: string;
  runError?: string;
  hasBranches?: boolean;
  createdAt?: string;
};

type Lane = {
  id: string;
  title: string;
  messages: Message[];
  activeRun: { id: string; sequence: number } | null;
  originKind?: "branch" | "clone";
  originLaneId?: string;
  originMessage?: Message;
  x: number;
  y: number;
  width: number;
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
  const [focusMode, setFocusMode] = useState(() => window.localStorage.getItem("workspace.focusMode") === "true");
  const [selectedLaneId, setSelectedLaneId] = useState(() => window.localStorage.getItem("workspace.selectedLaneId"));
  const canvasRef = useRef<HTMLElement | null>(null);

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

  async function saveLaneLayout(laneId: string, layout: { x: number; y: number; width: number }) {
    if (!activeBoardId) return;
    try {
      const updated = await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/layout`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(layout),
      });
      setBoard(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить положение ленты");
    }
  }

  async function copyMessage(sourceLaneId: string, messageId: string, targetLaneId: string) {
    setError(null);
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(sourceLaneId)}/messages/${encodeURIComponent(messageId)}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLaneId }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось скопировать блок");
    }
  }

  async function mutateMessage(messageId: string, content: string | null) {
    setError(null);
    try {
      const updated = await readJson<BoardResponse>(`/api/messages/${encodeURIComponent(messageId)}`, content === null ? {
        method: "DELETE",
      } : {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setBoard(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить историю");
    }
  }

  function selectLane(laneId: string) {
    setSelectedLaneId(laneId);
    window.localStorage.setItem("workspace.selectedLaneId", laneId);
    if (focusMode) centerLane(laneId);
  }

  function centerLane(laneId: string) {
    const lane = board?.lanes.find((item) => item.id === laneId);
    if (!lane) return;
    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.scrollTo({ ...getCenteredScrollTarget(lane, { width: canvas.clientWidth, height: canvas.clientHeight }), behavior: "smooth" });
    });
  }

  function toggleFocusMode() {
    const enabled = !focusMode;
    setFocusMode(enabled);
    window.localStorage.setItem("workspace.focusMode", String(enabled));
    if (enabled && selectedLaneId) centerLane(selectedLaneId);
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

  const canvasExtent = board ? getCanvasExtent(board.lanes) : null;

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
        <button className={`canvas-mode ${focusMode ? "selected" : ""}`} type="button" onClick={toggleFocusMode}>
          {focusMode ? "Фокус" : "Свободно"}
        </button>
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

      <section className="canvas" ref={canvasRef} aria-label="Рабочая область доски">
        {error && <p className="error-banner" role="alert">{error}</p>}
        {board && board.board.id === activeBoardId ? (
          <div
            className="lanes"
            key={board.board.id}
            style={{
              minWidth: canvasExtent!.minWidth,
              minHeight: canvasExtent!.minHeight,
            }}
          >
            {board.lanes.map((lane) => (
              <LaneView
                key={lane.id}
                lane={lane}
                lanes={board.lanes}
                authenticated={Boolean(codex?.authenticated)}
                onRefresh={() => refreshBoard(board.board.id)}
                onBranch={(messageId) => void createBranch(lane.id, messageId)}
                onClone={() => void cloneLane(lane.id)}
                onSelect={() => selectLane(lane.id)}
                onSaveLayout={(layout) => void saveLaneLayout(lane.id, layout)}
                onCopy={(messageId, targetLaneId) => void copyMessage(lane.id, messageId, targetLaneId)}
                onMutate={mutateMessage}
                selected={selectedLaneId === lane.id}
              />
            ))}
            <button
              className="new-lane"
              style={{ left: 24, top: canvasExtent!.newLaneY }}
              onClick={() => void createLane()}
            ><span>＋</span> Добавить ленту</button>
          </div>
        ) : <div className="loading">Открываю доску…</div>}
      </section>
    </main>
  );
}

function LaneView({ lane, lanes, authenticated, onRefresh, onBranch, onClone, onSelect, onSaveLayout, onCopy, onMutate, selected }: {
  lane: Lane;
  lanes: Lane[];
  authenticated: boolean;
  onRefresh: () => Promise<BoardResponse>;
  onBranch: (messageId: string) => void;
  onClone: () => void;
  onSelect: () => void;
  onSaveLayout: (layout: { x: number; y: number; width: number }) => void;
  onCopy: (messageId: string, targetLaneId: string) => void;
  onMutate: (messageId: string, content: string | null) => Promise<void>;
  selected: boolean;
}) {
  const [message, setMessage] = useState("");
  const [runState, setRunState] = useState<RunState>(emptyRunState());
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [layout, setLayout] = useState({ x: lane.x, y: lane.y, width: lane.width });
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [copyTarget, setCopyTarget] = useState("");

  useEffect(() => setLayout({ x: lane.x, y: lane.y, width: lane.width }), [lane.x, lane.y, lane.width]);

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

  function startMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, textarea")) return;
    event.preventDefault();
    onSelect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = layout;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const next = {
        ...origin,
        x: Math.max(0, origin.x + moveEvent.clientX - startX),
        y: Math.max(0, origin.y + moveEvent.clientY - startY),
      };
      layoutRef.current = next;
      setLayout(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onSaveLayout(layoutRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const initialWidth = layout.width;
    const move = (moveEvent: PointerEvent) => setLayout((current) => {
      const next = { ...current, width: Math.min(900, Math.max(280, initialWidth + moveEvent.clientX - startX)) };
      layoutRef.current = next;
      return next;
    });
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onSaveLayout(layoutRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Буфер обмена недоступен в этом браузере.");
    }
  }

  async function saveEdit(messageId: string) {
    if (!editedContent.trim()) return;
    const confirmed = window.confirm("Изменить этот блок и удалить все более поздние сообщения только в этой ленте? Уже созданные ветки и клоны сохранят прежнюю историю.");
    if (!confirmed) return;
    await onMutate(messageId, editedContent.trim());
    setEditingMessageId(null);
  }

  async function deleteTail(messageId: string) {
    const confirmed = window.confirm("Удалить это сообщение и все более поздние сообщения только в этой ленте? Уже созданные ветки и клоны сохранят прежнюю историю.");
    if (confirmed) await onMutate(messageId, null);
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
    <article className={`lane ${selected ? "selected" : ""}`} data-lane-id={lane.id} style={{ left: layout.x, top: layout.y, width: layout.width }}>
      <div className="lane-heading" onPointerDown={startMove} onClick={onSelect}>
        <span className="lane-dot" /><h2>{lane.title}</h2><span className="lane-provider">CODEX</span>
        <button className="lane-clone" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onClone} disabled={running}>Клон</button>
      </div>
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
            {editingMessageId === item.id ? (
              <div className="message-editor">
                <textarea value={editedContent} onChange={(event) => setEditedContent(event.target.value)} aria-label="Изменить сообщение" />
                <button type="button" onClick={() => void saveEdit(item.id)}>Сохранить и удалить хвост</button>
                <button type="button" onClick={() => setEditingMessageId(null)}>Отмена</button>
              </div>
            ) : <MarkdownContent content={item.content} />}
            {item.runStatus === "failed" && <p className="message-error">{item.runError ?? "Ответ не завершён."}</p>}
            <div className="message-actions">
              {item.hasBranches && <span className="branch-existing">Есть ветка</span>}
              <button type="button" onClick={() => onBranch(item.id)} disabled={running}>Ответвиться здесь</button>
              <button type="button" onClick={() => void copyText(item.content)}>Копировать текст</button>
              <button type="button" onClick={() => { setEditingMessageId(item.id); setEditedContent(item.content); }} disabled={running}>Изменить</button>
              <button type="button" onClick={() => void deleteTail(item.id)} disabled={running}>Удалить с хвостом</button>
              {lanes.length > 1 && (
                <span className="copy-block">
                  <select aria-label="Целевая лента" value={copyTarget} onChange={(event) => setCopyTarget(event.target.value)}>
                    <option value="">В другую ленту…</option>
                    {lanes.filter((target) => target.id !== lane.id).map((target) => (
                      <option key={target.id} value={target.id} disabled={Boolean(target.activeRun)}>{target.title}{target.activeRun ? " · запрос идёт" : ""}</option>
                    ))}
                  </select>
                  <button type="button" disabled={!copyTarget || running} onClick={() => { onCopy(item.id, copyTarget); setCopyTarget(""); }}>Копировать блок</button>
                </span>
              )}
            </div>
          </article>
        ))}
        {runId && runState.status === "running" && runState.answer && (
                <article className="message assistant streaming" aria-label="Ответ Codex поступает">
            <div className="message-label">CODEX · ОТВЕТ</div>
          <MarkdownContent content={runState.answer} /><span className="cursor" />
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
      <div className="lane-resize" onPointerDown={startResize} role="separator" aria-label="Изменить ширину ленты" />
    </article>
  );
}
