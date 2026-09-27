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
  instructions: string;
  instructionMode: "inherit" | "override" | "append";
  effectiveInstructions: string;
  mcpTools: Array<{ serverId: string; toolName: string }>;
  mcpAutoApprove: boolean;
  stickyFacts: Array<{ key: string; value: string; updatedAt: string }>;
  mcpApprovals: Array<{ id: string; serverId: string; toolName: string; arguments: Record<string, unknown>; reason: string; status: string; approvalSource?: string; createdAt: string }>;
};

type BoardSummary = { id: string; title: string; instructions: string };
type Agent = { id: string; name: string; description: string; instructions: string };
type BoardResponse = { board: BoardSummary; lanes: Lane[]; agents?: Agent[] };
type MemoryItem = { key: string; value: string; updatedAt: string };
type BoardMemoryState = { workingMemories: Array<{ id: string; name: string; createdAt: string; items: MemoryItem[] }>; longTerm: MemoryItem[] };
type BoardTask = { id: string; title: string; description: string; status: "open" | "done"; stage: "planning" | "execution" | "validation" | "done"; plan: string; planApproved: boolean; currentStep: string; expectedAction: string; paused: boolean; comments: Array<{ content: string; createdAt: string }> };
type CodexStatus = { authenticated: boolean; planType?: string; error?: string };
type CodexModel = { slug?: string; displayName?: string; isDefault?: boolean };
type McpCatalogServer = { id: string; name: string; description: string; status: "connected" | "error"; error?: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }> };

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
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [newLaneProvider, setNewLaneProvider] = useState<"codex" | "openrouter">("codex");
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(() => window.localStorage.getItem("workspace.focusMode") === "true");
  const [selectedLaneId, setSelectedLaneId] = useState(() => window.localStorage.getItem("workspace.selectedLaneId"));
  const canvasRef = useRef<HTMLElement | null>(null);

  const refreshBoard = useCallback(async (boardId: string) => {
    const value = await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(boardId)}`);
    setBoard(value);
    setMemoryRevision((revision) => revision + 1);
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

  async function saveBoardInstructions(boardId: string, instructions: string) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(boardId)}/instructions`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить инструкции доски"); }
  }

  async function saveLaneInstructions(laneId: string, instructions: string, mode: Lane["instructionMode"]) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/instructions`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instructions, mode }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить инструкции ленты"); }
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

  async function setMcpAutoApprove(laneId: string, autoApprove: boolean) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/mcp-approval-settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoApprove }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройку подтверждений"); }
  }

  async function decideMcpApproval(laneId: string, approvalId: string, decision: "approve" | "deny" | "close_uncertain") {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/mcp-approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось обработать предложение"); }
  }

  async function editFact(laneId: string, key: string, value: string | null) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/facts${value === null ? `/${encodeURIComponent(key)}` : ""}`, {
        method: value === null ? "DELETE" : "PATCH",
        ...(value === null ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) }),
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить факты"); }
  }

  async function clearFacts(laneId: string) {
    try { setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/facts`, { method: "DELETE" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось очистить факты"); }
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
      {board && <BoardInstructionEditor boardId={board.board.id} value={board.board.instructions} onSave={(value) => void saveBoardInstructions(board.board.id, value)} />}

      {board && board.board.id === activeBoardId && <BoardMemoryOverview boardId={board.board.id} revision={memoryRevision} />}
      {board && board.board.id === activeBoardId && <BoardTaskOverview key={`tasks-${board.board.id}`} boardId={board.board.id} />}
      {board && board.board.id === activeBoardId && <BoardScheduleOverview key={`schedules-${board.board.id}`} boardId={board.board.id} />}

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
                boardInstructions={board.board.instructions}
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
                onSaveInstructions={(instructions, mode) => void saveLaneInstructions(lane.id, instructions, mode)}
                onSaveMcpTools={(tools) => void saveMcpTools(lane.id, tools)}
                onAutoApprove={(enabled) => void setMcpAutoApprove(lane.id, enabled)}
                onApproval={(approvalId, decision) => void decideMcpApproval(lane.id, approvalId, decision)}
                onEditFact={(key, value) => void editFact(lane.id, key, value)}
                onClearFacts={() => void clearFacts(lane.id)}
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

function BoardInstructionEditor({ boardId, value, onSave }: { boardId: string; value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [boardId, value]);
  return <details className="board-instructions">
    <summary>Инструкции доски · по умолчанию</summary>
    <label>AGENTS-текст для всех лент<textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={20_000} /></label>
    <p>Это prompt-level правило модели. Оно передаётся в запросе, но сервер сам его не обеспечивает.</p>
    <button type="button" disabled={draft === value} onClick={() => onSave(draft)}>Сохранить инструкции доски</button>
  </details>;
}

function BoardMemoryOverview({ boardId, revision }: { boardId: string; revision: number }) {
  const [memory, setMemory] = useState<BoardMemoryState>({ workingMemories: [], longTerm: [] });
  const [newMemoryName, setNewMemoryName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const base = `/api/boards/${encodeURIComponent(boardId)}/memories`;
  const refresh = useCallback(async () => setMemory(await readJson<BoardMemoryState>(base)), [base]);
  useEffect(() => { void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить память доски")); }, [refresh, revision]);

  async function mutate(url: string, init: RequestInit) {
    try { setMemory(await readJson<BoardMemoryState>(url, init)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить память доски"); }
  }

  async function createMemory(event: FormEvent) {
    event.preventDefault();
    if (!newMemoryName.trim()) return;
    await mutate(`${base}/working`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newMemoryName.trim() }) });
    setNewMemoryName("");
  }

  function itemUrl(layer: "working" | "longTerm", memoryName: string, key: string) {
    const addressName = layer === "longTerm" ? "-" : memoryName;
    return `${base}/${layer}/${encodeURIComponent(addressName)}/${encodeURIComponent(key)}`;
  }

  function saveItem(layer: "working" | "longTerm", memoryName: string, key: string, value: string) {
    return mutate(itemUrl(layer, memoryName, key), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) });
  }

  function deleteItem(layer: "working" | "longTerm", memoryName: string, key: string) {
    return mutate(itemUrl(layer, memoryName, key), { method: "DELETE" });
  }

  return <details className="board-memory-overview">
    <summary>Память доски · {memory.workingMemories.length} рабочих пространств · {memory.longTerm.length} общих записей</summary>
    <div className="board-memory-content">
      <p>Рабочие памяти доступны всем лентам доски по именам. Долговременная память общая для доски. Эти данные хранятся отдельно от истории лент.</p>
      <form className="memory-create-form" onSubmit={(event) => void createMemory(event)}>
        <input aria-label="Имя рабочей памяти" placeholder="Новая рабочая память" value={newMemoryName} onChange={(event) => setNewMemoryName(event.target.value)} />
        <button type="submit" disabled={!newMemoryName.trim()}>Создать</button>
      </form>
      {memory.workingMemories.map((workspace) => <MemoryLayerEditor key={workspace.id} title={`Рабочая память · ${workspace.name}`} items={workspace.items}
        onSave={(key, value) => saveItem("working", workspace.name, key, value)} onDelete={(key) => deleteItem("working", workspace.name, key)}
        onClear={() => mutate(`${base}/working/${encodeURIComponent(workspace.name)}`, { method: "DELETE" })}
        onRemove={() => mutate(`/api/boards/${encodeURIComponent(boardId)}/working-memories/${encodeURIComponent(workspace.name)}`, { method: "DELETE" })} />)}
      <MemoryLayerEditor title="Долговременная память · общая для доски" items={memory.longTerm}
        onSave={(key, value) => saveItem("longTerm", "", key, value)} onDelete={(key) => deleteItem("longTerm", "", key)}
        onClear={() => mutate(`${base}/longTerm/-`, { method: "DELETE" })} />
      {error && <p className="memory-overview-error" role="alert">{error}</p>}
    </div>
  </details>;
}

function BoardTaskOverview({ boardId }: { boardId: string }) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const base = `/api/boards/${encodeURIComponent(boardId)}/tasks`;
  const refresh = useCallback(async () => setTasks((await readJson<{ tasks: BoardTask[] }>(base)).tasks), [base]);
  useEffect(() => { void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить задачи")); }, [refresh]);

  async function mutate(taskId: string, patch: Record<string, unknown>) {
    try { const updated = await readJson<BoardTask>(`${base}/${encodeURIComponent(taskId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); setTasks((items) => items.map((item) => item.id === taskId ? updated : item)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Изменение задачи отклонено"); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    try { const created = await readJson<BoardTask>(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim(), description: description.trim() }) }); setTasks((items) => [created, ...items]); setTitle(""); setDescription(""); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать задачу"); }
  }

  const nextStage: Record<BoardTask["stage"], BoardTask["stage"] | null> = { planning: "execution", execution: "validation", validation: "done", done: null };
  return <details className="board-tasks" open>
    <summary>Задачи доски · {tasks.length}</summary>
    <div className="board-tasks-content">
      <p>Состояние хранится отдельно для каждой доски. Переход возможен только на следующий этап; план нужно утвердить до выполнения.</p>
      <form className="task-create-form" onSubmit={(event) => void create(event)}>
        <input aria-label="Название задачи" placeholder="Новая задача" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
        <input aria-label="Описание задачи" placeholder="Описание" maxLength={10000} value={description} onChange={(event) => setDescription(event.target.value)} />
        <button type="submit" disabled={!title.trim()}>Создать</button>
      </form>
      {tasks.map((task) => <TaskEditor key={task.id} task={task} onSave={(patch) => mutate(task.id,patch)} />)}
      {tasks.length === 0 && <small>На этой доске пока нет задач.</small>}
      {error && <p className="task-error" role="alert">{error}</p>}
    </div>
  </details>;
}

type Schedule = { id: string; title: string; repeatEveryMs?: number; nextRunAt: number; status: string };
type ScheduleRun = { id: string; scheduleId: string; title: string; scheduledFor: number; startedAt?: number; status: string; missedCount: number; result?: { sampleCount: number; total: number; average: number; minimum: number; maximum: number }; error?: string };

function BoardScheduleOverview({ boardId }: { boardId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [title, setTitle] = useState("Сводка метрик");
  const [firstDelay, setFirstDelay] = useState(2000);
  const [repeatEvery, setRepeatEvery] = useState<number | null>(2000);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/boards/${encodeURIComponent(boardId)}`;
  const refresh = useCallback(async () => {
    const [scheduleResult, runResult] = await Promise.all([
      readJson<{ schedules: Schedule[] }>(`${base}/schedules`),
      readJson<{ runs: ScheduleRun[] }>(`${base}/schedule-runs`),
    ]);
    setSchedules(scheduleResult.schedules);
    setRuns(runResult.runs);
  }, [base]);
  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить расписания"));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  async function create(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      await readJson<Schedule>(`${base}/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, delayMs: firstDelay, repeatEveryMs: repeatEvery }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось создать расписание"); }
  }
  async function pause(schedule: Schedule) {
    setError(null);
    try {
      await readJson<Schedule>(`${base}/schedules/${encodeURIComponent(schedule.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: schedule.status !== "paused" }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить расписание"); }
  }
  const date = (timestamp: number) => new Date(timestamp).toLocaleTimeString();
  return <details className="board-schedules" open>
    <summary>Локальные расписания · безопасная сводка демо-метрик</summary>
    <div className="board-schedules-content">
      <p>Сервис выполняет расписания, пока работает backend, даже если браузер закрыт. Интервалы 2 и 5 секунд подходят для демонстрации.</p>
      <form className="schedule-create-form" onSubmit={(event) => void create(event)}>
        <input aria-label="Название расписания" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
        <label>Старт через<select value={firstDelay} onChange={(event) => setFirstDelay(Number(event.target.value))}><option value={250}>0,25 с</option><option value={1000}>1 с</option><option value={2000}>2 с</option><option value={5000}>5 с</option><option value={60000}>1 мин</option></select></label>
        <label>Повтор<select value={repeatEvery ?? "once"} onChange={(event) => setRepeatEvery(event.target.value === "once" ? null : Number(event.target.value))}><option value="once">Один раз</option><option value={1000}>Каждую 1 с</option><option value={2000}>Каждые 2 с</option><option value={5000}>Каждые 5 с</option><option value={60000}>Каждую минуту</option></select></label>
        <button type="submit" disabled={!title.trim()}>Создать</button>
      </form>
      {error && <p className="schedule-error" role="alert">{error}</p>}
      <div className="schedule-list">{schedules.length === 0 && <p>Расписаний пока нет.</p>}{schedules.map((schedule) => <article className="schedule-card" key={schedule.id}>
        <strong>{schedule.title}</strong><span>{schedule.status === "paused" ? "приостановлено" : schedule.status === "completed" ? "завершено" : `следующий запуск: ${date(schedule.nextRunAt)}`}</span>
        {schedule.status !== "completed" && <button type="button" onClick={() => void pause(schedule)}>{schedule.status === "paused" ? "Возобновить" : "Пауза"}</button>}
      </article>)}</div>
      <h4>История запусков</h4>
      <div className="schedule-runs">{runs.length === 0 && <p>Результатов пока нет.</p>}{runs.slice(0, 12).map((run) => <article className="schedule-run" key={run.id}>
        <strong>{run.title}</strong><span>{run.status} · {date(run.startedAt ?? run.scheduledFor)}{run.missedCount > 0 ? ` · пропущено слотов: ${run.missedCount}` : ""}</span>
        {run.result && <span>n={run.result.sampleCount}, сумма {run.result.total}, среднее {run.result.average.toFixed(1)}, min/max {run.result.minimum}/{run.result.maximum}</span>}{run.error && <span className="schedule-error">{run.error}</span>}
      </article>)}</div>
    </div>
  </details>;
}

function TaskEditor({ task, onSave }: { task: BoardTask; onSave: (patch: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [plan, setPlan] = useState(task.plan);
  const [step, setStep] = useState(task.currentStep);
  const [action, setAction] = useState(task.expectedAction);
  const [comment, setComment] = useState("");
  const next: Record<BoardTask["stage"], BoardTask["stage"] | null> = { planning: "execution", execution: "validation", validation: "done", done: null };
  useEffect(() => { setTitle(task.title); setDescription(task.description); setPlan(task.plan); setStep(task.currentStep); setAction(task.expectedAction); }, [task]);
  return <article className="task-card">
    <div className="task-heading"><strong>{task.title}</strong><span>{task.stage} · {task.status}{task.paused ? " · пауза" : ""}</span></div>
    <div className="task-edit-fields">
      <input aria-label="Название задачи" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      <textarea aria-label="Описание задачи" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} />
      <button type="button" onClick={() => void onSave({ title, description })}>Сохранить описание</button>
      <label>План<textarea aria-label="План задачи" value={plan} onChange={(event) => setPlan(event.target.value)} maxLength={10000} disabled={task.stage !== "planning"} /></label>
      <div className="task-actions">
        <button type="button" onClick={() => void onSave({ plan })} disabled={task.stage !== "planning" || plan === task.plan}>Сохранить план</button>
        <button type="button" onClick={() => void onSave({ approvePlan: true })} disabled={task.stage !== "planning" || !task.plan.trim() || task.planApproved}>Утвердить план</button>
        <button type="button" onClick={() => void onSave({ stage: next[task.stage] })} disabled={!next[task.stage] || task.paused || (task.stage === "planning" && !task.planApproved)}>{next[task.stage] ? `Перейти: ${next[task.stage]}` : "Завершено"}</button>
        {task.stage !== "done" && <button type="button" onClick={() => void onSave({ paused: !task.paused })}>{task.paused ? "Продолжить" : "Пауза"}</button>}
      </div>
      <label>Текущий шаг<input value={step} onChange={(event) => setStep(event.target.value)} maxLength={1000} /></label>
      <label>Ожидаемое действие<input value={action} onChange={(event) => setAction(event.target.value)} maxLength={1000} /></label>
      <button type="button" onClick={() => void onSave({ currentStep: step, expectedAction: action })}>Сохранить состояние шага</button>
      <form className="task-comment-form" onSubmit={(event) => { event.preventDefault(); if (comment.trim()) void onSave({ comment }).then(() => setComment("")); }}>
        <input aria-label="Комментарий" placeholder="Комментарий" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={4000} />
        <button type="submit" disabled={!comment.trim()}>Добавить</button>
      </form>
    </div>
    {task.planApproved && <small>План утверждён</small>}
    {task.comments.length > 0 && <ul className="task-comments">{task.comments.map((item, index) => <li key={`${item.createdAt}:${index}`}>{item.content}</li>)}</ul>}
  </article>;
}

function MemoryLayerEditor({ title, items, onSave, onDelete, onClear, onRemove }: {
  title: string;
  items: MemoryItem[];
  onSave: (key: string, value: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return <section className="board-memory-layer">
    <div className="board-memory-layer-title"><strong>{title}</strong>{items.length > 0 && <button type="button" onClick={() => void onClear()}>Очистить записи</button>}{onRemove && <button type="button" onClick={() => void onRemove()}>Удалить память</button>}</div>
    {items.length === 0 ? <small>Записей пока нет.</small> : <ul>{items.map((item) => <li key={item.key}>
      <strong>{item.key}</strong><input key={`${item.key}:${item.value}`} defaultValue={item.value} aria-label={`Значение ${item.key}`} onBlur={(event) => { if (event.currentTarget.value !== item.value) void onSave(item.key, event.currentTarget.value); }} />
      <button type="button" onClick={() => void onDelete(item.key)}>Удалить</button>
    </li>)}</ul>}
    <form className="memory-item-form" onSubmit={(event) => { event.preventDefault(); if (!key.trim() || !value.trim()) return; void onSave(key.trim(), value.trim()).then(() => { setKey(""); setValue(""); }); }}>
      <input aria-label={`Новый ключ · ${title}`} placeholder="Ключ" value={key} onChange={(event) => setKey(event.target.value)} />
      <input aria-label={`Новое значение · ${title}`} placeholder="Значение" value={value} onChange={(event) => setValue(event.target.value)} />
      <button type="submit" disabled={!key.trim() || !value.trim()}>Сохранить</button>
    </form>
  </section>;
}

function LaneView({ lane, boardInstructions, agentName, lanes, authenticated, openRouterConfigured, codexModels, mcpServers, onRefresh, onBranch, onClone, onSelect, onSaveLayout, onCopy, onMutate, onSaveConfig, onSaveInstructions, onSaveMcpTools, onAutoApprove, onApproval, onEditFact, onClearFacts, onCancelRun, selected }: {
  lane: Lane;
  boardInstructions: string;
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
  onSaveInstructions: (instructions: string, mode: Lane["instructionMode"]) => void;
  onSaveMcpTools: (tools: Lane["mcpTools"]) => void;
  onAutoApprove: (enabled: boolean) => void;
  onApproval: (approvalId: string, decision: "approve" | "deny" | "close_uncertain") => void;
  onEditFact: (key: string, value: string | null) => void;
  onClearFacts: () => void;
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
  const [instructionDraft, setInstructionDraft] = useState(lane.instructions);
  const [instructionMode, setInstructionMode] = useState<Lane["instructionMode"]>(lane.instructionMode);
  const [forceSend, setForceSend] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [toolEvents, setToolEvents] = useState<Array<Record<string, unknown>>>([]);
  const [newFactKey, setNewFactKey] = useState("");
  const [newFactValue, setNewFactValue] = useState("");
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
  useEffect(() => { setInstructionDraft(lane.instructions); setInstructionMode(lane.instructionMode); }, [lane.instructions, lane.instructionMode]);
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
        <section className="lane-instructions">
          <strong>AGENTS-инструкции ленты</strong>
          <label>Режим
            <select value={instructionMode} onChange={(event) => setInstructionMode(event.target.value as Lane["instructionMode"])}>
              <option value="inherit">Наследовать доску</option>
              <option value="override">Заменить инструкции доски</option>
              <option value="append">Дополнить инструкции доски</option>
            </select>
          </label>
          <label>Текст ленты<textarea value={instructionDraft} maxLength={20_000} onChange={(event) => setInstructionDraft(event.target.value)} disabled={instructionMode === "inherit"} /></label>
          <button type="button" disabled={instructionMode === lane.instructionMode && instructionDraft === lane.instructions} onClick={() => onSaveInstructions(instructionDraft, instructionMode)}>Сохранить инструкции ленты</button>
          <p>Перед следующим запросом модели отправится этот эффективный текст (prompt-level правило):</p>
          <pre>{instructionMode === "override" ? instructionDraft : instructionMode === "append" ? [boardInstructions, instructionDraft].filter(Boolean).join("\n\n") : boardInstructions || "Нет инструкций"}</pre>
          <small>Сервер передаёт текст модели, но не обеспечивает его выполнение. Для hard constraint нужна отдельная серверная проверка.</small>
        </section>
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
                <span><b>{tool.name} · {tool.readOnly ? "только чтение" : "требует подтверждения"}</b><small>{tool.description}</small><code>{JSON.stringify(tool.inputSchema, null, 2)}</code></span>
              </label>;
            })}
          </section>)}
          <p className="mcp-memory-note">Инструмент даёт модели возможность запросить данные текущей ленты или доски. Это не обещает улучшение ответа: результат зависит от вызова модели. Источник, аргументы и результат видны в ленте.</p>
          <small>Команда запуска задана сервером приложения; доска и модель выбирают только зарегистрированные инструменты.</small>
          <label className="mcp-tool-option"><input type="checkbox" checked={lane.mcpAutoApprove} onChange={(event) => onAutoApprove(event.target.checked)} />
            <span><b>Автоматически подтверждать изменяющие вызовы</b><small>Выключено по умолчанию. Включение разрешает выбранным инструментам выполнять изменения; источник согласия сохраняется с каждым вызовом.</small></span>
          </label>
          <section className="sticky-facts">
            <strong>Постоянные факты этой ленты</strong>
            <p>Модель может читать факты и предложить обновление. Предложение не меняет данные до подтверждения.</p>
            {lane.stickyFacts.map((fact) => <label key={fact.key}>Ключ · {fact.key}
              <input key={`${fact.key}-${fact.value}`} defaultValue={fact.value} aria-label={`Факт ${fact.key}`} onBlur={(event) => { if (event.currentTarget.value !== fact.value) onEditFact(fact.key, event.currentTarget.value); }} />
              <button type="button" onClick={() => onEditFact(fact.key, null)}>Удалить</button>
            </label>)}
            <div className="sticky-fact-add"><input aria-label="Ключ нового факта" placeholder="Ключ" value={newFactKey} onChange={(event) => setNewFactKey(event.target.value)} />
              <input aria-label="Значение нового факта" placeholder="Значение" value={newFactValue} onChange={(event) => setNewFactValue(event.target.value)} />
              <button type="button" disabled={!newFactKey.trim() || !newFactValue.trim()} onClick={() => { onEditFact(newFactKey, newFactValue); setNewFactKey(""); setNewFactValue(""); }}>Сохранить вручную</button>
            </div>
            {lane.stickyFacts.length > 0 && <button type="button" onClick={onClearFacts}>Очистить факты</button>}
          </section>
          {lane.mcpApprovals.slice(0, 20).map((approval) => <section className="mcp-approval" key={approval.id}>
            <strong>{approval.serverId}/{approval.toolName} · {({ pending: "ожидает подтверждения", applying: "выполняется", approved: "подтверждено", denied: "отклонено", failed: "ошибка выполнения", uncertain: "результат неизвестен после прерывания", uncertain_closed: "закрыто вручную · результат неизвестен" } as Record<string, string>)[approval.status] ?? approval.status}</strong>
            <pre>{JSON.stringify(approval.arguments, null, 2)}</pre><p>Причина: {approval.reason}</p>
            {approval.approvalSource && <small>Источник согласия: {approval.approvalSource === "user" ? "подтверждение пользователя" : "настройка autoapprove ленты"}</small>}
            {approval.status === "pending" && <><p>Действие ещё не выполнено; {approval.serverId === "board-memory" ? "память не изменена" : "факт не сохранён"}.</p>
              <button type="button" onClick={() => onApproval(approval.id, "approve")}>Подтвердить</button>
              <button type="button" onClick={() => onApproval(approval.id, "deny")}>Отклонить</button></>}
            {approval.status === "uncertain" && <><p>Выполнение прервалось. Внешнее действие могло выполниться; автоматического повтора не будет. Проверь результат вручную, затем закрой эту запись.</p>
              <button type="button" onClick={() => onApproval(approval.id, "close_uncertain")}>Закрыть после ручной проверки</button></>}
            {approval.status === "uncertain_closed" && <p>Запись закрыта вручную. Исход внешнего действия остаётся неизвестным.</p>}
          </section>)}
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
            {item.requestConfig && <details className="request-details"><summary>Параметры и снимок инструкций запроса</summary><pre>{JSON.stringify({ config: item.requestConfig, result: item.technicalDetails }, null, 2)}</pre></details>}
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
