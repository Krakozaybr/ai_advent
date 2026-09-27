import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { applyRunEvent, emptyRunState, RunEvent, RunState } from "./run-state.mjs";
import { chooseBoardId } from "./workspace-state.mjs";
import { describeLaneOrigin } from "./lane-lineage.mjs";
import { MarkdownContent } from "./MarkdownContent";
import { getCanvasExtent, getCenteredScrollTarget } from "./canvas-layout.mjs";
import { isContextSummaryStale, planContext } from "./context-plan.mjs";
import type { ContextStrategy } from "./context-plan.mjs";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  provenance?: string;
  runStatus?: string;
  runError?: string;
  hasBranches?: boolean;
  createdAt?: string;
  requestConfig?: Record<string, unknown>;
  technicalDetails?: Record<string, unknown>;
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
  agentId?: string;
  provider: "codex" | "openrouter";
  model: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string;
  contextStrategy: ContextStrategy;
  contextWindowSize: number;
  contextSummary: string;
  contextSummaryWatermark?: string;
  contextSummaryUsage?: Record<string, unknown>;
  contextSummaryUsageSource?: string;
  contextSummaryStale: boolean;
  contextBudgetTokens: number;
  mcpTools: Array<{ serverId: string; toolName: string }>;
};

type BoardSummary = { id: string; title: string };
type Agent = { id: string; name: string; description: string; instructions: string };
type BoardResponse = { board: BoardSummary; lanes: Lane[]; agents?: Agent[] };
type CodexStatus = { authenticated: boolean; planType?: string; error?: string };
type CodexModel = { slug?: string; displayName?: string; isDefault?: boolean };
type McpCatalogServer = { id: string; name: string; description: string; status: "connected" | "error"; error?: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };

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
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [openRouterConfigured, setOpenRouterConfigured] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [mcpServers, setMcpServers] = useState<McpCatalogServer[]>([]);
  const [newLaneProvider, setNewLaneProvider] = useState<"codex" | "openrouter">("codex");
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
      const result = await readJson<{ models: CodexModel[] }>("/api/codex/models");
      setCodexModels(result.models);
    } catch (cause) {
      setCodex({ authenticated: false, error: cause instanceof Error ? cause.message : "Codex недоступен" });
    }
  }, []);

  const refreshOpenRouter = useCallback(async () => {
    const status = await readJson<{ configured: boolean }>("/api/openrouter/status");
    setOpenRouterConfigured(status.configured);
  }, []);

  const refreshMcpCatalog = useCallback(async () => {
    const result = await readJson<{ servers: McpCatalogServer[] }>("/api/mcp/catalog");
    setMcpServers(result.servers);
  }, []);

  const refreshBoards = useCallback(async () => {
    const result = await readJson<{ boards: BoardSummary[] }>("/api/boards");
    setBoards(result.boards);
    const saved = window.localStorage.getItem("workspace.activeBoardId");
    const requested = new URLSearchParams(window.location.search).get("boardId");
    const selected = requested && result.boards.some((board) => board.id === requested)
      ? requested
      : chooseBoardId(saved, result.boards);
    setActiveBoardId(selected);
    if (selected) {
      window.localStorage.setItem("workspace.activeBoardId", selected);
      await refreshBoard(selected);
    }
  }, [refreshBoard]);

  useEffect(() => {
    void Promise.all([refreshBoards(), refreshCodex(), refreshOpenRouter(), refreshMcpCatalog()]).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить доски");
    });
  }, [refreshBoards, refreshCodex, refreshOpenRouter, refreshMcpCatalog]);

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
      setBoard(await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(activeBoardId)}/lanes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: newLaneProvider }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать ленту");
    }
  }

  async function saveLaneConfig(laneId: string, config: Pick<Lane, "model" | "temperature" | "maxTokens" | "stop" | "contextStrategy" | "contextWindowSize" | "contextBudgetTokens">) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить параметры ленты");
    }
  }

  async function saveMcpTools(laneId: string, tools: Lane["mcpTools"]) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/mcp-tools`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tools }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить выбор инструментов");
    }
  }

  async function saveOpenRouterKey() {
    try {
      const result = await readJson<{ configured: boolean }>("/api/openrouter/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: openRouterKey }),
      });
      setOpenRouterConfigured(result.configured);
      setOpenRouterKey("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить ключ OpenRouter");
    }
  }

  async function cancelRun(runId: string) {
    try {
      await readJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отменить запрос");
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
        <details className="provider-settings">
          <summary>Ключ OpenRouter</summary>
          <form onSubmit={(event) => { event.preventDefault(); void saveOpenRouterKey(); }}>
            <span>{openRouterConfigured ? "Ключ сохранён на сервере" : "Ключ не задан"}</span>
            <input type="password" autoComplete="new-password" value={openRouterKey} onChange={(event) => setOpenRouterKey(event.target.value)} placeholder="sk-or-…" aria-label="API-ключ OpenRouter" />
            <button type="submit" disabled={!openRouterKey.trim()}>Сохранить</button>
          </form>
        </details>
      </header>

      {!codex?.authenticated && (
        <div className="login-banner">
          <span>Войди через подписку ChatGPT, чтобы отправлять запросы через Codex.</span>
          <span>Ключ API не нужен.</span>
        </div>
      )}

      {board?.agents && board.agents.length > 0 && <section className="board-agents" aria-label="Агенты доски">
        {board.agents.map((agent) => <details key={agent.id}>
          <summary>Агент · {agent.name}</summary>
          <p>{agent.description}</p>
          <pre>{agent.instructions}</pre>
        </details>)}
      </section>}

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
                agentName={board.agents?.find((agent) => agent.id === lane.agentId)?.name}
                lanes={board.lanes}
                authenticated={Boolean(codex?.authenticated)}
                openRouterConfigured={openRouterConfigured}
                codexModels={codexModels}
                mcpServers={mcpServers}
                onRefresh={() => refreshBoard(board.board.id)}
                onBranch={(messageId) => void createBranch(lane.id, messageId)}
                onClone={() => void cloneLane(lane.id)}
                onSelect={() => selectLane(lane.id)}
                onSaveLayout={(layout) => void saveLaneLayout(lane.id, layout)}
                onCopy={(messageId, targetLaneId) => void copyMessage(lane.id, messageId, targetLaneId)}
                onMutate={mutateMessage}
                onSaveConfig={(config) => void saveLaneConfig(lane.id, config)}
                onSaveMcpTools={(tools) => void saveMcpTools(lane.id, tools)}
                onCancelRun={cancelRun}
                selected={selectedLaneId === lane.id}
              />
            ))}
            <div
              className="new-lane"
              style={{ left: 24, top: canvasExtent!.newLaneY }}
            >
              <select aria-label="Провайдер новой ленты" value={newLaneProvider} onChange={(event) => setNewLaneProvider(event.target.value as "codex" | "openrouter")}>
                <option value="codex">Codex</option><option value="openrouter">OpenRouter</option>
              </select>
              <button type="button" onClick={() => void createLane()}><span>＋</span> Добавить ленту</button>
            </div>
          </div>
        ) : <div className="loading">Открываю доску…</div>}
      </section>
    </main>
  );
}

function LaneView({ lane, agentName, lanes, authenticated, openRouterConfigured, codexModels, mcpServers, onRefresh, onBranch, onClone, onSelect, onSaveLayout, onCopy, onMutate, onSaveConfig, onSaveMcpTools, onCancelRun, selected }: {
  lane: Lane;
  agentName?: string;
  lanes: Lane[];
  authenticated: boolean;
  openRouterConfigured: boolean;
  codexModels: CodexModel[];
  mcpServers: McpCatalogServer[];
  onRefresh: () => Promise<BoardResponse>;
  onBranch: (messageId: string) => void;
  onClone: () => void;
  onSelect: () => void;
  onSaveLayout: (layout: { x: number; y: number; width: number }) => void;
  onCopy: (messageId: string, targetLaneId: string) => void;
  onMutate: (messageId: string, content: string | null) => Promise<void>;
  onSaveConfig: (config: Pick<Lane, "model" | "temperature" | "maxTokens" | "stop" | "contextStrategy" | "contextWindowSize" | "contextBudgetTokens">) => void;
  onSaveMcpTools: (tools: Lane["mcpTools"]) => void;
  onCancelRun: (runId: string) => void;
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
  const [config, setConfig] = useState({ model: lane.model, temperature: lane.temperature ?? 0.7, maxTokens: lane.maxTokens ?? 2048, stop: lane.stop ?? "", contextStrategy: lane.contextStrategy, contextWindowSize: lane.contextWindowSize, contextBudgetTokens: lane.contextBudgetTokens });
  const [forceSend, setForceSend] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [toolEvents, setToolEvents] = useState<Array<Record<string, unknown>>>([]);
  const providerReady = lane.provider === "codex" ? authenticated : openRouterConfigured;

  function persistConfig(next = config) {
    onSaveConfig(lane.provider === "codex" ? {
      model: next.model,
      contextStrategy: next.contextStrategy,
      contextWindowSize: next.contextWindowSize,
      contextBudgetTokens: next.contextBudgetTokens,
    } : next);
  }

  useEffect(() => setLayout({ x: lane.x, y: lane.y, width: lane.width }), [lane.x, lane.y, lane.width]);
  useEffect(() => setConfig({ model: lane.model, temperature: lane.temperature ?? 0.7, maxTokens: lane.maxTokens ?? 2048, stop: lane.stop ?? "", contextStrategy: lane.contextStrategy, contextWindowSize: lane.contextWindowSize, contextBudgetTokens: lane.contextBudgetTokens }), [lane.model, lane.temperature, lane.maxTokens, lane.stop, lane.contextStrategy, lane.contextWindowSize, lane.contextBudgetTokens]);

  const contextPlan = planContext(
    lane.messages.filter((item) => item.content.length > 0).map((item) => ({ role: item.role, content: item.content })),
    message.trim(),
    { strategy: config.contextStrategy, windowSize: config.contextWindowSize, summary: lane.contextSummary, summaryWatermark: lane.contextSummaryWatermark, budgetTokens: config.contextBudgetTokens, responseTokensEstimate: lane.provider === "codex" ? 1024 : config.maxTokens || 1024 },
  );
  const beforeCompression = planContext(
    lane.messages.filter((item) => item.content.length > 0).map(({ role, content }) => ({ role, content })),
    message.trim(),
    { strategy: "full", windowSize: config.contextWindowSize, summary: "", budgetTokens: config.contextBudgetTokens, responseTokensEstimate: lane.provider === "codex" ? 1024 : config.maxTokens || 1024 },
  );
  const summaryStale = isContextSummaryStale(lane.contextSummary, lane.contextSummaryWatermark, lane.messages.at(-1)?.id, lane.contextSummaryStale);

  async function generateSummary() {
    setSummaryBusy(true);
    setError(null);
    try {
      await readJson(`/api/lanes/${lane.id}/context-summary`, { method: "POST" });
      await onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать сводку");
    } finally {
      setSummaryBusy(false);
    }
  }

  const listenToRun = useCallback((id: string, after: number) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/runs/${id}/events?after=${after}`);
    sourceRef.current = source;
    source.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as RunEvent;
      setRunState((current) => applyRunEvent(current, data));
      if (data.type === "tool.started") setToolEvents((current) => [...current, { ...data.data, status: "Выполняется" }]);
      if (data.type === "tool.completed") setToolEvents((current) => {
        const next = [...current];
        const index = next.findIndex((item) => item.toolName === data.data.toolName && item.status === "Выполняется");
        if (index >= 0) next[index] = { ...data.data, status: data.data.ok ? "Готово" : "Ошибка" };
        return next;
      });
      if (data.type === "run.completed" || data.type === "run.failed" || data.type === "run.cancelled") {
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
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, select, textarea, input, details")) return;
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
    setToolEvents([]);
    try {
      const parameters = lane.provider === "codex" ? { model: config.model } : {
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        stop: config.stop,
      };
      const result = await readJson<{ runId: string }>(`/api/lanes/${lane.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, parameters: { ...parameters, forceSend } }),
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
        <span className="lane-dot" /><h2>{lane.title}</h2>{agentName && <span className="lane-provider">Агент · {agentName}</span>}<span className="lane-provider">{lane.provider.toUpperCase()}</span>
        <button className="lane-clone" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onClone} disabled={running}>Клон</button>
      </div>
      <details className="lane-settings">
        <summary>Запрос · {config.model || "модель по умолчанию"}</summary>
        <label>Модель
          {lane.provider === "codex" && codexModels.length > 0 ? (
            <select value={config.model} onChange={(event) => { const next = { ...config, model: event.target.value }; setConfig(next); persistConfig(next); }}>
              <option value="">Модель Codex по умолчанию</option>
              {codexModels.map((model) => model.slug && <option key={model.slug} value={model.slug}>{model.displayName ?? model.slug}{model.isDefault ? " · по умолчанию" : ""}</option>)}
            </select>
          ) : <input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} onBlur={() => persistConfig()} aria-label="Модель" />}
        </label>
        {lane.provider === "openrouter" && <>
          <label>Temperature<input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={(event) => setConfig({ ...config, temperature: Number(event.target.value) })} onBlur={() => persistConfig()} /></label>
          <label>Максимум токенов<input type="number" min="1" max="200000" step="1" value={config.maxTokens} onChange={(event) => setConfig({ ...config, maxTokens: Number(event.target.value) })} onBlur={() => persistConfig()} /></label>
          <label>Stop<input value={config.stop} onChange={(event) => setConfig({ ...config, stop: event.target.value })} onBlur={() => persistConfig()} /></label>
        </>}
        <details className="mcp-tools">
          <summary>MCP-инструменты · {lane.mcpTools.length} разрешено</summary>
          {lane.provider === "codex" && <p className="capability-gate">Codex app-server не подтверждает доступ ленты к этим MCP-инструментам. Реальное выполнение сейчас поддержано только через OpenRouter.</p>}
          {mcpServers.map((server) => <section key={server.id}>
            <strong>{server.name}</strong>
            <small>{server.description} · {server.status === "connected" ? "подключён" : `ошибка: ${server.error ?? "недоступен"}`}</small>
            {server.tools.map((tool) => {
              const checked = lane.mcpTools.some((item) => item.serverId === server.id && item.toolName === tool.name);
              return <label className="mcp-tool-option" key={`${server.id}/${tool.name}`}>
                <input type="checkbox" checked={checked} disabled={lane.provider !== "openrouter" || server.status !== "connected" || running}
                  onChange={(event) => {
                    const key = { serverId: server.id, toolName: tool.name };
                    const next = event.target.checked ? [...lane.mcpTools, key] : lane.mcpTools.filter((item) => item.serverId !== key.serverId || item.toolName !== key.toolName);
                    onSaveMcpTools(next);
                  }} />
                <span><b>{tool.name}</b><small>{tool.description}</small><code>{JSON.stringify(tool.inputSchema, null, 2)}</code></span>
              </label>;
            })}
          </section>)}
          <small>Команда запуска задана сервером приложения; доска и модель выбирают только зарегистрированные инструменты.</small>
        </details>
        <label>История
          <select value={config.contextStrategy} onChange={(event) => { const next = { ...config, contextStrategy: event.target.value as ContextStrategy }; setConfig(next); persistConfig(next); setForceSend(false); }}>
            <option value="full">Полная история</option>
            <option value="sliding_window">Последние N сообщений</option>
            <option value="summary_window">Сводка + последние N</option>
          </select>
        </label>
        {config.contextStrategy !== "full" && <label>Размер окна
          <input type="number" min="1" max="200" value={config.contextWindowSize} onChange={(event) => { const next = { ...config, contextWindowSize: Number(event.target.value) }; setConfig(next); }} onBlur={() => persistConfig()} />
        </label>}
        <label>Бюджет контекста · оценка токенов
          <input type="number" min="256" max="1000000" step="1024" value={config.contextBudgetTokens} onChange={(event) => setConfig({ ...config, contextBudgetTokens: Number(event.target.value) })} onBlur={() => persistConfig()} />
        </label>
        {config.contextStrategy === "summary_window" && <section className="context-summary">
          <div className="context-summary-heading">
            <strong>Отдельная сводка</strong>
            <button type="button" disabled={!providerReady || running || summaryBusy} onClick={() => void generateSummary()}>{summaryBusy ? "Создаю…" : lane.contextSummary ? "Обновить явно" : "Создать явно"}</button>
          </div>
          <p>{lane.contextSummaryWatermark ? `Сводка сохранена до сообщения ${lane.contextSummaryWatermark.slice(0, 8)}${lane.messages.at(-1)?.id === lane.contextSummaryWatermark ? " · актуальна" : " · есть новые сообщения"}` : "Сводка ещё не создавалась."}</p>
          {lane.contextSummary && <pre>{lane.contextSummary}</pre>}
          {lane.contextSummaryUsageSource && <small>Usage ответа сводки · {lane.contextSummaryUsageSource}: {JSON.stringify(lane.contextSummaryUsage ?? "провайдер не прислал")}</small>}
          <small>Генерация отправляет полный сохранённый transcript выбранному провайдеру и не меняет историю диалога.</small>
        </section>}
      </details>
      {lane.originKind && (
        <div className={`lane-origin ${lane.originKind}`}>
          <span aria-hidden="true">↳</span>
          <span>{describeLaneOrigin(lane.originKind, lane.originMessage?.content).label}</span>
          {lane.originMessage?.content && <q>{describeLaneOrigin(lane.originKind, lane.originMessage.content).excerpt}</q>}
        </div>
      )}
      <div className="lane-messages" aria-live="polite">
        {toolEvents.map((item, index) => <details className="tool-run-event" key={`${String(item.toolName)}-${index}`} open>
          <summary>Инструмент · {String(item.toolName)} · {String(item.status)}</summary>
          <pre>{JSON.stringify(item, null, 2)}</pre>
        </details>)}
        {lane.messages.filter((item) => !(item.role === "assistant" && item.runStatus === "running")).map((item) => (
          <article className={`message ${item.role}`} key={item.id}>
            <div className="message-label">{item.role === "user" ? "ТЫ" : lane.provider.toUpperCase()}</div>
            {editingMessageId === item.id ? (
              <div className="message-editor">
                <textarea value={editedContent} onChange={(event) => setEditedContent(event.target.value)} aria-label="Изменить сообщение" />
                <button type="button" onClick={() => void saveEdit(item.id)}>Сохранить и удалить хвост</button>
                <button type="button" onClick={() => setEditingMessageId(null)}>Отмена</button>
              </div>
            ) : <MarkdownContent content={item.content} />}
            {item.provenance && <small className="message-provenance">{item.provenance}</small>}
            {item.runStatus === "failed" && <p className="message-error">{item.runError ?? "Ответ не завершён."}</p>}
            {item.requestConfig && <details className="request-details"><summary>Параметры запроса</summary><pre>{JSON.stringify({ config: item.requestConfig, result: item.technicalDetails }, null, 2)}</pre></details>}
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
                <article className="message assistant streaming" aria-label="Ответ модели поступает">
            <div className="message-label">{lane.provider.toUpperCase()} · ОТВЕТ</div>
          <MarkdownContent content={runState.answer} /><span className="cursor" />
          </article>
        )}
        {lane.messages.length === 0 && !running && <div className="empty-state"><span className="empty-symbol">✳</span><p>Новый диалог</p><span>Напиши запрос внизу ленты.</span></div>}
      </div>
      {error && <p className="lane-error" role="alert">{error}</p>}
      {runState.status === "failed" && runState.error && !error && <p className="lane-error" role="alert">{runState.error}</p>}
      <form className="composer" onSubmit={(event) => void sendMessage(event)}>
        <div className="context-estimate" aria-live="polite">
          <span>Текущее сообщение: ~{contextPlan.currentMessageTokensEstimate} токенов</span>
          <span>История после: ~{contextPlan.historyTokensEstimate}; до сжатия: ~{beforeCompression.historyTokensEstimate}</span>
          <span>Вход: ~{contextPlan.inputTokensEstimate} + ответ ~{contextPlan.responseTokensEstimate}; бюджет {contextPlan.budgetTokens}</span>
          {contextPlan.omittedMessages > 0 && <span>План сжимает историю на {contextPlan.omittedMessages} сообщений.</span>}
          {contextPlan.summaryMissing && <span className="context-warning">Сводка ещё не создана: старые сообщения останутся только в transcript и не попадут в запрос.</span>}
          {summaryStale && config.contextStrategy === "summary_window" && <span className="context-warning">Сводка устарела относительно transcript; обнови её явно.</span>}
        </div>
        <details className="context-plan-details"><summary>Состав отправляемого запроса</summary><pre>{JSON.stringify(contextPlan.messages, null, 2)}</pre></details>
        {contextPlan.overflow && <label className="force-send">
          <input type="checkbox" checked={forceSend} onChange={(event) => setForceSend(event.target.checked)} />
          Оценка выше бюджета. Отправить всё равно; провайдер может отклонить запрос.
        </label>}
        <textarea
          ref={textareaRef}
          aria-label={`Сообщение для ${lane.title}`}
          placeholder={providerReady ? "Напиши сообщение…" : lane.provider === "codex" ? "Войди в Codex, чтобы отправить запрос" : "Добавь ключ OpenRouter в настройках"}
          value={message}
          onChange={(event) => { setMessage(event.target.value); setForceSend(false); resizeTextarea(event.currentTarget); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          disabled={!providerReady || running}
        />
        <div className="composer-footer">
          <span>{running ? "Запрос выполняется" : contextPlan.overflow && !forceSend ? "Подтверди отправку выше оценки бюджета" : "Enter — отправить · Shift+Enter — новая строка"}</span>
          {running && runId && <button type="button" className="cancel-run" onClick={() => onCancelRun(runId)}>Отменить</button>}
          <button className="button primary" type="submit" disabled={!providerReady || running || !message.trim() || (contextPlan.overflow && !forceSend)} aria-label="Отправить сообщение">
            ↗
          </button>
        </div>
      </form>
      <div className="lane-resize" onPointerDown={startResize} role="separator" aria-label="Изменить ширину ленты" />
    </article>
  );
}
