import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyRunEvent, applyToolRunEvent, emptyRunState, RunEvent, RunState } from "./run-state.mjs";
import { chooseBoardId } from "./workspace-state.mjs";
import { describeLaneOrigin } from "./lane-lineage.mjs";
import { MarkdownContent } from "./MarkdownContent";
import { getCanvasExtent } from "./canvas-layout.mjs";
import { arrangeLanes } from "./workspace-layout.mjs";
import { centerCameraOnLane, panCamera, stickyHeaderOffset, zoomCameraAt } from "./workspace-camera.mjs";
import type { WorkspaceCamera } from "./workspace-camera.mjs";
import { isContextSummaryStale, planContext } from "./context-plan.mjs";
import type { ContextStrategy } from "./context-plan.mjs";
import { createOverviewPanelState, setOverviewPanelOpen } from "./overview-panels.mjs";
import { tokenizeJson, wasConfigurationChanged } from "./run-details.mjs";
import { Icon } from "./Icons";
import { createPortal } from "react-dom";

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
type QueuedMessage = { id: string; content: string; createdAt: string; status: "pending" | "failed"; error?: string };
const SESSION_SKILLS = [
  { id: "files", name: "Работа с файлами", description: "Проверяй доступные файлы и показывай точные пути и изменения." },
  { id: "planning", name: "Планирование", description: "Разбивай цель на проверяемые шаги и отмечай зависимости." },
  { id: "web-search", name: "Поиск в сети", description: "Используй только реально подключённый поиск и указывай источники." },
] as const;

type Lane = {
  id: string;
  title: string;
  messages: Message[];
  queuedMessages?: QueuedMessage[];
  skills?: string[];
  activeRun: { id: string; sequence: number } | null;
  originKind?: "branch" | "clone" | "subagent";
  originLaneId?: string;
  originMessageId?: string;
  originMessage?: Message;
  launchOrder?: number;
  subagentPinned?: boolean;
  subagentsExpanded?: boolean;
  archived?: boolean;
  groupColor?: string;
  x: number;
  y: number;
  width: number;
  agentId?: string;
  provider: "codex" | "openrouter";
  providerChosen?: boolean;
  model: string;
  effort?: string;
  serviceTier?: string;
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

type BoardSummary = { id: string; title: string; instructions: string; archived?: boolean };
type Agent = { id: string; name: string; description: string; instructions: string };
type BoardResponse = { board: BoardSummary; lanes: Lane[]; agents?: Agent[] };
type Confirmation = { title: string; description: string; confirmLabel: string; onConfirm: () => void | Promise<void> };
type MemoryItem = { key: string; value: string; updatedAt: string };
type BoardMemoryState = { workingMemories: Array<{ id: string; name: string; createdAt: string; items: MemoryItem[] }>; longTerm: MemoryItem[] };
type BoardTask = { id: string; title: string; description: string; status: "open" | "done"; stage: "planning" | "execution" | "validation" | "done"; plan: string; planApproved: boolean; currentStep: string; expectedAction: string; paused: boolean; comments: Array<{ content: string; createdAt: string }> };
type CodexStatus = { authenticated: boolean; planType?: string; error?: string };
type CodexModel = { id?: string; model?: string; slug?: string; displayName?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>; serviceTiers?: Array<{ id: string; name: string }> };
type McpCatalogServer = { id: string; name: string; description: string; status: "connected" | "error"; error?: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }> };
type DemoPipelineStep = { serverId: string; toolName: string; arguments: Record<string, unknown>; result: Record<string, unknown> };
type DemoPipelineResult = { steps: DemoPipelineStep[]; output: Record<string, unknown> };

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

export function BoardChat() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [showHome, setShowHome] = useState(false);
  const [showSessionArchive, setShowSessionArchive] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [closedBoardIds, setClosedBoardIds] = useState<string[]>(() => {
    try { return JSON.parse(window.localStorage.getItem("workspace.closedBoards") ?? "[]") as string[]; }
    catch { return []; }
  });
  const [colorDraft, setColorDraft] = useState<{ laneId: string; value: string } | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [openRouterConfigured, setOpenRouterConfigured] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [mcpServers, setMcpServers] = useState<McpCatalogServer[]>([]);
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(() => window.localStorage.getItem("workspace.focusMode") === "true");
  const [selectedLaneId, setSelectedLaneId] = useState(() => window.localStorage.getItem("workspace.selectedLaneId"));
  const [overviewPanels, setOverviewPanels] = useState(createOverviewPanelState);
  const canvasRef = useRef<HTMLElement | null>(null);
  const activeBoardTabRef = useRef<HTMLDivElement | null>(null);
  const [boardCameras, setBoardCameras] = useState<Record<string, WorkspaceCamera>>({});
  const [linkedYs, setLinkedYs] = useState<Record<string, number>>({});
  const [groupPreview, setGroupPreview] = useState<{ rootId: string; dx: number; dy: number } | null>(null);
  const camera = activeBoardId ? boardCameras[activeBoardId] : null;

  useLayoutEffect(() => {
    if (!showHome) activeBoardTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeBoardId, showHome, boards.length]);

  const refreshBoard = useCallback(async (boardId: string) => {
    const value = await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(boardId)}`);
    setBoard(value);
    setMemoryRevision((revision) => revision + 1);
    return value;
  }, []);

  useEffect(() => {
    if (!activeBoardId || showHome || !board?.board.title.startsWith("День 18")) return;
    let active = true;
    let loading = false;
    const timer = window.setInterval(async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(activeBoardId)}`);
        if (active) setBoard((current) => current?.board.id === activeBoardId && JSON.stringify(current) !== JSON.stringify(value) ? value : current);
      } catch { /* Следующая проверка повторит запрос. */ }
      finally { loading = false; }
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [activeBoardId, showHome, board?.board.title]);

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
    const available = result.boards.filter((board) => !board.archived);
    const selected = requested && available.some((board) => board.id === requested)
      ? requested
      : chooseBoardId(saved, available);
    setActiveBoardId(selected);
    if (selected) {
      window.localStorage.setItem("workspace.activeBoardId", selected);
      await refreshBoard(selected);
    } else { setBoard(null); setShowHome(true); }
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
    setShowHome(false);
    setClosedBoardIds((current) => {
      const next = current.filter((id) => id !== boardId);
      window.localStorage.setItem("workspace.closedBoards", JSON.stringify(next));
      return next;
    });
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
      const created = await readJson<BoardResponse>("/api/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chooseProvider: true }) });
      setBoards((current) => [...current, created.board]);
      await selectBoard(created.board.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать доску");
    }
  }

  function closeBoard(boardId: string) {
    setClosedBoardIds((current) => {
      const next = [...new Set([...current, boardId])];
      window.localStorage.setItem("workspace.closedBoards", JSON.stringify(next));
      return next;
    });
    if (activeBoardId === boardId) setShowHome(true);
  }

  async function archiveBoard(boardId: string, archived: boolean) {
    try {
      await readJson(`/api/boards/${encodeURIComponent(boardId)}/archive`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
      });
      const result = await readJson<{ boards: BoardSummary[] }>("/api/boards");
      setBoards(result.boards);
      if (archived && activeBoardId === boardId) setShowHome(true);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить архив доски"); }
  }

  async function deleteBoard(boardId: string, title: string) {
    setConfirmation({ title: `Удалить доску «${title}»?`, description: "Все её сессии будут скрыты. Данные останутся в локальной базе для ручного восстановления.", confirmLabel: "Удалить доску", onConfirm: async () => {
      try {
        const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `HTTP ${response.status}`);
        if (activeBoardId === boardId) { setShowHome(true); setActiveBoardId(null); setBoard(null); }
        setClosedBoardIds((current) => current.filter((id) => id !== boardId));
        setBoards((await readJson<{ boards: BoardSummary[] }>("/api/boards")).boards);
        setError(null);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить доску"); }
    } });
  }

  async function archiveLane(laneId: string, archived: boolean) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/archive`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }),
      }));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось изменить архив сессии"); }
  }

  async function deleteLane(laneId: string, title: string) {
    setConfirmation({ title: `Удалить сессию «${title}»?`, description: "Вместе с ней будут удалены все её ветки и сообщения. Действие нельзя отменить в приложении.", confirmLabel: "Удалить сессию", onConfirm: async () => {
      try {
        setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}`, { method: "DELETE" }));
        setError(null);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить сессию"); }
    } });
  }

  function confirmAction(title: string, description: string, confirmLabel: string, onConfirm: () => void | Promise<void>) {
    setConfirmation({ title, description, confirmLabel, onConfirm });
  }

  async function renameLane(laneId: string, title: string) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/title`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
      }));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось переименовать сессию"); }
  }

  async function applyGroupColor(laneId: string, color: string) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/group-color`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color }),
      }));
      setColorDraft(null);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить цвет группы"); }
  }

  async function createLane(referenceLaneId?: string, side: "before" | "after" = "after") {
    if (!activeBoardId || !board) return;
    setError(null);
    try {
      const created = await readJson<BoardResponse>(`/api/boards/${encodeURIComponent(activeBoardId)}/lanes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chooseProvider: true }),
      });
      const previousIds = new Set(board.lanes.map((lane) => lane.id));
      const newLane = created.lanes.find((lane) => !previousIds.has(lane.id));
      if (!newLane) throw new Error("Новая сессия не появилась на доске");
      const roots = board.lanes.filter((lane) => !lane.archived && lane.originKind !== "branch" && lane.originKind !== "subagent").sort((a, b) => a.x - b.x);
      const reference = referenceLaneId ? board.lanes.find((lane) => lane.id === referenceLaneId) : null;
      const referenceRoot = reference ? rootForLane(reference) : null;
      const referenceIndex = referenceRoot ? roots.findIndex((lane) => lane.id === referenceRoot.id) : roots.length - 1;
      const insertionIndex = referenceIndex + (side === "after" ? 1 : 0);
      const before = roots[insertionIndex - 1];
      const after = roots[insertionIndex];
      const x = before && after ? Math.floor((before.x + after.x) / 2) : before ? before.x + 1 : Math.max(0, (after?.x ?? 161) - 1);
      const updated = await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(newLane.id)}/layout`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y: 24, width: newLane.width }),
      });
      setBoard(updated);
      setSelectedLaneId(newLane.id);
      window.localStorage.setItem("workspace.selectedLaneId", newLane.id);
      const placed = arrangeLanes(updated.lanes).find((lane) => lane.id === newLane.id);
      const canvas = canvasRef.current;
      if (focusMode && placed && canvas) {
        setBoardCameras((current) => ({ ...current, [activeBoardId]: centerCameraOnLane(placed,
          { width: canvas.clientWidth, height: canvas.clientHeight }, current[activeBoardId]?.zoom ?? 0.9,
          current[activeBoardId]?.y) }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать сессию");
    }
  }

  async function chooseLaneProvider(laneId: string, provider: Lane["provider"]) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/provider`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }),
      }));
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выбрать провайдера"); }
  }

  async function saveLaneConfig(laneId: string, config: Pick<Lane, "model" | "temperature" | "maxTokens" | "stop" | "contextStrategy" | "contextWindowSize" | "contextBudgetTokens" | "effort" | "serviceTier">) {
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

  async function saveLaneSkills(laneId: string, skills: string[]) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/skills`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skills }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить навыки сессии");
    }
  }

  async function saveSubagents(laneId: string, expanded: boolean, pinned: string[]) {
    try {
      setBoard(await readJson<BoardResponse>(`/api/lanes/${encodeURIComponent(laneId)}/subagents`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expanded, pinned }),
      }));
      if (!expanded && selectedLaneId) {
        let child = board?.lanes.find((item) => item.id === selectedLaneId);
        const visited = new Set<string>();
        while (child?.originLaneId && !visited.has(child.id)) {
          if (child.originLaneId === laneId && child.originKind === "subagent") { selectLane(laneId); break; }
          visited.add(child.id);
          child = board?.lanes.find((item) => item.id === child?.originLaneId);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки сабагентов");
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
    const lane = arrangeLanes(board?.lanes ?? []).find((item) => item.id === laneId);
    const canvas = canvasRef.current;
    if (!lane || !canvas || !activeBoardId) return;
    const next = centerCameraOnLane(lane, { width: canvas.clientWidth, height: canvas.clientHeight }, camera?.zoom ?? 0.9, camera?.y);
    setBoardCameras((current) => ({ ...current, [activeBoardId]: next }));
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!board || board.board.id !== activeBoardId || !activeBoardId || !canvas || !board.lanes.some((lane) => !lane.archived)) return;
    setBoardCameras((current) => current[activeBoardId] ? current : {
      ...current,
      [activeBoardId]: centerCameraOnLane(arrangeLanes(board.lanes)[0], { width: canvas.clientWidth, height: canvas.clientHeight }),
    });
  }, [board, activeBoardId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeBoardId || board?.board.id !== activeBoardId) return;
    const handleWheel = (event: WheelEvent) => {
      if ((event.target as Element).closest("textarea, input, select, pre, .lane-settings[open]")) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      setBoardCameras((current) => {
        const previous = current[activeBoardId];
        if (!previous) return current;
        const focusedLane = focusMode ? arrangeLanes(board.lanes).find((lane) => lane.id === selectedLaneId) : null;
        const next = event.ctrlKey || event.metaKey
          ? zoomCameraAt(previous, Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top }, focusedLane, rect.width)
          : panCamera(previous, focusMode ? 0 : (event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit,
            event.shiftKey && !event.deltaX && !focusMode ? 0 : event.deltaY * unit, focusMode);
        return { ...current, [activeBoardId]: next };
      });
    };
    const handleMiddleDown = (event: PointerEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      let lastX = event.clientX;
      let lastY = event.clientY;
      const move = (next: PointerEvent) => {
        const deltaX = lastX - next.clientX;
        const deltaY = lastY - next.clientY;
        lastX = next.clientX;
        lastY = next.clientY;
        setBoardCameras((current) => {
          const previous = current[activeBoardId];
          return previous ? { ...current, [activeBoardId]: panCamera(previous, deltaX, deltaY, focusMode) } : current;
        });
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", handleMiddleDown);
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("pointerdown", handleMiddleDown);
    };
  }, [activeBoardId, board, focusMode, selectedLaneId]);

  function zoomBy(factor: number) {
    const canvas = canvasRef.current;
    if (!canvas || !activeBoardId) return;
    const focusedLane = focusMode ? arrangeLanes(board?.lanes ?? []).find((lane) => lane.id === selectedLaneId) : null;
    setBoardCameras((current) => {
      const previous = current[activeBoardId];
      if (!previous) return current;
      return { ...current, [activeBoardId]: zoomCameraAt(previous, factor,
        { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, focusedLane, canvas.clientWidth) };
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

  function laneIsVisible(lane: Lane, visited = new Set<string>()): boolean {
    if (lane.archived || visited.has(lane.id)) return false;
    if (lane.originKind !== "branch" && lane.originKind !== "subagent") return true;
    const parent = board?.lanes.find((item) => item.id === lane.originLaneId);
    if (!parent || !laneIsVisible(parent, new Set([...visited, lane.id]))) return false;
    if (lane.originKind === "subagent") {
      return Boolean(parent.subagentsExpanded && (lane.activeRun || lane.subagentPinned));
    }
    return true;
  }

  const arrangedLanes: Lane[] = arrangeLanes((board?.lanes ?? []).filter((lane) => laneIsVisible(lane)));
  const visibleLanes = arrangedLanes.map((lane) => ({ ...lane, y: linkedYs[lane.id] ?? lane.y }));
  const canvasExtent = board ? getCanvasExtent(visibleLanes) : null;
  const archivedLanes = board?.lanes.filter((lane) => lane.archived) ?? [];
  const openBoards = boards.filter((item) => !item.archived && !closedBoardIds.includes(item.id));

  useLayoutEffect(() => {
    if (!board || showHome || !camera) return;
    const stage = canvasRef.current?.querySelector(".lanes");
    if (!stage) return;
    const elements = [...stage.querySelectorAll<HTMLElement>(".lane[data-lane-id]")];
    const byId = new Map(elements.map((element) => [element.dataset.laneId, element]));
    const next: Record<string, number> = {};
    for (const lane of visibleLanes) {
      if ((lane.originKind !== "branch" && lane.originKind !== "subagent") || !lane.originLaneId || !lane.originMessageId) continue;
      const parent = byId.get(lane.originLaneId);
      const child = byId.get(lane.id);
      const source = [...(parent?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])]
        .find((element) => element.dataset.messageId === lane.originMessageId);
      if (!parent || !child || !source) continue;
      const sourceOffset = (source.getBoundingClientRect().top - parent.getBoundingClientRect().top) / camera.zoom;
      const headerHeight = (child.querySelector(".lane-heading")?.getBoundingClientRect().height ?? 0) / camera.zoom;
      const parentY = visibleLanes.find((item) => item.id === lane.originLaneId)?.y ?? 0;
      const launchOffset = lane.originKind === "subagent" ? ((lane.launchOrder ?? 1) - 1) * 20 : 0;
      next[lane.id] = Math.max(0, Math.round(parentY + sourceOffset - headerHeight - 8 + launchOffset));
    }
    setLinkedYs((current) => {
      const keys = Object.keys(next);
      return keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]) ? current : next;
    });
  }, [board, camera?.zoom, showHome, linkedYs]);

  function rootForLane(lane: Lane): Lane {
    let root = lane;
    const visited = new Set<string>();
    while ((root.originKind === "branch" || root.originKind === "subagent") && root.originLaneId && !visited.has(root.id)) {
      visited.add(root.id);
      const parent = board?.lanes.find((item) => item.id === root.originLaneId);
      if (!parent) break;
      root = parent;
    }
    return root;
  }

  const renderLanes = visibleLanes.map((lane) => groupPreview?.rootId === rootForLane(lane).id
    ? { ...lane, x: lane.x + groupPreview.dx, y: lane.y + groupPreview.dy }
    : lane);
  const isDemoPipelineBoard = board?.board.title.startsWith("День 19 ·") ?? false;

  return (
    <main className="shell">
      <header className="topbar">
        <nav className="board-tabs" aria-label="Доски">
          <button className={`board-tab home-tab ${showHome ? "selected" : ""}`} onClick={() => setShowHome(true)} aria-current={showHome ? "page" : undefined}>Home</button>
          {openBoards.map((item) => (
            <div ref={item.id === activeBoardId && !showHome ? activeBoardTabRef : null} className={`board-tab-wrap ${item.id === activeBoardId && !showHome ? "selected" : ""}`} key={item.id}>
              <button className="board-tab" onClick={() => void selectBoard(item.id)} aria-current={item.id === activeBoardId && !showHome ? "page" : undefined}>{item.title}</button>
              <button className="board-tab-close" type="button" aria-label={`Закрыть вкладку ${item.title}`} onClick={() => closeBoard(item.id)}>×</button>
            </div>
          ))}
          <button className="add-board" aria-label="Создать доску" title="Создать доску" onClick={() => void createBoard()}>＋</button>
        </nav>
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

      {!showHome && !isDemoPipelineBoard && board && board.board.id === activeBoardId && <details className="workspace-tools">
        <summary>Доска и инструменты</summary>
        <div className="workspace-tools-content">
          {board.agents && board.agents.length > 0 && <section className="board-agents" aria-label="Агенты доски">
            {board.agents.map((agent) => <details key={agent.id}>
              <summary>Агент · {agent.name}</summary>
              <p>{agent.description}</p>
              <pre>{agent.instructions}</pre>
            </details>)}
          </section>}
          <BoardInstructionEditor boardId={board.board.id} value={board.board.instructions} onSave={(value) => void saveBoardInstructions(board.board.id, value)} />
          <BoardMemoryOverview boardId={board.board.id} revision={memoryRevision} />
          <BoardTaskOverview boardId={board.board.id} open={overviewPanels.tasks} onToggle={(open) => setOverviewPanels((state) => setOverviewPanelOpen(state, "tasks", open))} />
          <BoardScheduleOverview boardId={board.board.id} agentLaneId={board.board.title.startsWith("День 18") ? board.lanes[0]?.id : undefined} open={overviewPanels.schedules} onToggle={(open) => setOverviewPanels((state) => setOverviewPanelOpen(state, "schedules", open))} onConfirmAction={confirmAction} />
        </div>
      </details>}

      {showHome ? <main className="home-screen"><div className="home-content">
        <div className="home-heading"><div><h1>Доски</h1><p>Открой доску или создай новую. Закрытая вкладка остаётся здесь.</p></div><button className="home-create" type="button" onClick={() => void createBoard()}>＋ Создать доску</button></div>
        <div className="home-grid">{boards.filter((item) => !item.archived).map((item) => <article className="board-card" key={item.id}>
          <div className="board-card-top"><span>{closedBoardIds.includes(item.id) ? "Вкладка закрыта" : "Открыта"}</span><span>{item.id === activeBoardId ? board?.lanes.length ?? "" : ""}</span></div>
          <h2>{item.title}</h2><div className="board-card-actions"><button type="button" onClick={() => void selectBoard(item.id)}>Открыть</button><button type="button" title="В архив" aria-label={`В архив: ${item.title}`} onClick={() => void archiveBoard(item.id, true)}><Icon name="archive" /></button><button type="button" title="Удалить доску" aria-label={`Удалить доску ${item.title}`} onClick={() => void deleteBoard(item.id, item.title)}><Icon name="trash" /></button></div>
        </article>)}</div>
        {boards.some((item) => item.archived) && <section className="home-archive"><h2>Архив досок</h2><div className="home-grid">{boards.filter((item) => item.archived).map((item) => <article className="board-card" key={item.id}>
          <div className="board-card-top"><span>В архиве</span></div><h2>{item.title}</h2><div className="board-card-actions"><button type="button" onClick={() => void archiveBoard(item.id, false)}>Восстановить</button><button type="button" title="Удалить доску" aria-label={`Удалить доску ${item.title}`} onClick={() => void deleteBoard(item.id, item.title)}><Icon name="trash" /></button></div>
        </article>)}</div></section>}
      </div></main> : isDemoPipelineBoard && board ? <DemoPipelineScreen key={board.board.id} boardId={board.board.id} /> : <section className="canvas" ref={canvasRef} aria-label="Рабочая область доски" style={camera ? {
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
      } : undefined}>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {board && board.board.id === activeBoardId ? (
          <div
            className="lanes"
            key={board.board.id}
            style={{
              minWidth: canvasExtent!.minWidth,
              minHeight: canvasExtent!.minHeight,
              transform: `translate(${camera?.x ?? 0}px, ${camera?.y ?? 0}px) scale(${camera?.zoom ?? 0.9})`,
              "--board-center-y": `${((canvasRef.current?.clientHeight ?? 600) / 2 - (camera?.y ?? 0)) / (camera?.zoom ?? 0.9)}px`,
            } as CSSProperties}
          >
            {renderLanes.filter((lane) => rootForLane(lane).id === lane.id && renderLanes.some((item) => item.id !== lane.id && rootForLane(item).id === lane.id)).map((root) => {
              const members = renderLanes.filter((lane) => rootForLane(lane).id === root.id);
              const left = Math.min(...members.map((lane) => lane.x));
              const right = Math.max(...members.map((lane) => lane.x + lane.width));
              return <div className="group-surface" key={root.id} style={{ left: left - 33, width: right - left + 66, "--group-color": colorDraft?.laneId === root.id ? colorDraft.value : root.groupColor ?? "#9fb7d3" } as CSSProperties} />;
            })}
            {renderLanes.map((lane) => (
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
                onSaveLayout={(layout) => { void saveLaneLayout(lane.id, layout).finally(() => setGroupPreview(null)); }}
                onPreviewMove={(dx, dy) => { if (rootForLane(lane).id === lane.id && renderLanes.some((item) => item.id !== lane.id && rootForLane(item).id === lane.id)) setGroupPreview({ rootId: lane.id, dx, dy }); }}
                onCopy={(messageId, targetLaneId) => void copyMessage(lane.id, messageId, targetLaneId)}
                onMutate={mutateMessage}
                onSaveConfig={(config) => void saveLaneConfig(lane.id, config)}
                onSaveInstructions={(instructions, mode) => void saveLaneInstructions(lane.id, instructions, mode)}
                onSaveMcpTools={(tools) => void saveMcpTools(lane.id, tools)}
                onSaveSkills={(skills) => void saveLaneSkills(lane.id, skills)}
                onSaveSubagents={(expanded, pinned) => void saveSubagents(lane.id, expanded, pinned)}
                onAutoApprove={(enabled) => void setMcpAutoApprove(lane.id, enabled)}
                onApproval={(approvalId, decision) => void decideMcpApproval(lane.id, approvalId, decision)}
                onEditFact={(key, value) => void editFact(lane.id, key, value)}
                onClearFacts={() => void clearFacts(lane.id)}
                onCancelRun={cancelRun}
                selected={selectedLaneId === lane.id}
                zoom={camera?.zoom ?? 0.9}
                cameraY={camera?.y ?? 0}
                groupColor={colorDraft?.laneId === rootForLane(lane).id ? colorDraft.value : rootForLane(lane).groupColor ?? "#9fb7d3"}
                isGroupRoot={rootForLane(lane).id === lane.id}
                inColorGroup={renderLanes.some((item) => item.id !== rootForLane(lane).id && rootForLane(item).id === rootForLane(lane).id)}
                hasBranches={visibleLanes.some((item) => item.id !== lane.id && rootForLane(item).id === lane.id)}
                onRename={(title) => void renameLane(lane.id, title)}
                onArchive={() => void archiveLane(lane.id, true)}
                onDelete={() => void deleteLane(lane.id, lane.title)}
                onChooseProvider={(provider) => void chooseLaneProvider(lane.id, provider)}
                colorDraft={colorDraft?.laneId === lane.id ? colorDraft.value : null}
                onColorDraft={(value) => setColorDraft(value === null ? null : { laneId: lane.id, value })}
                onApplyColor={(value) => void applyGroupColor(lane.id, value)}
                onConfirmAction={confirmAction}
              />
            ))}
            {renderLanes.map((lane, index) => {
              const next = renderLanes[index + 1];
              if (!next) return null;
              const boundaryX = lane.x + lane.width;
              const sameGroup = rootForLane(lane).id === rootForLane(next).id;
              return <div className={`column-boundary ${sameGroup ? "group-boundary" : ""}`} key={`${lane.id}-${next.id}`} style={{ left: boundaryX }}>
                <span className="boundary-line" />
                {!sameGroup && <div className="boundary-actions">
                  <button type="button" title="Добавить сессию после группы" aria-label="Добавить сессию слева от границы" onClick={() => void createLane(lane.id, "after")}><Icon name="plus" /></button>
                  <button type="button" title="Добавить сессию перед группой" aria-label="Добавить сессию справа от границы" onClick={() => void createLane(next.id, "before")}><Icon name="plus" /></button>
                </div>}
              </div>;
            })}
            {renderLanes.length > 0 && <>
              <div className="outer-add-zone left-zone" style={{ left: renderLanes[0].x - 66 }}><span className="outer-line" /><button type="button" aria-label="Добавить сессию слева" onClick={() => void createLane(renderLanes[0].id, "before")}><Icon name="plus" size={19} /></button></div>
              <div className="outer-add-zone right-zone" style={{ left: renderLanes.at(-1)!.x + renderLanes.at(-1)!.width }}><span className="outer-line" /><button type="button" aria-label="Добавить сессию справа" onClick={() => void createLane(renderLanes.at(-1)!.id, "after")}><Icon name="plus" size={19} /></button></div>
            </>}
          </div>
        ) : <div className="loading">Открываю доску…</div>}
        <div className="canvas-controls">
          <button className={`canvas-mode ${focusMode ? "selected" : ""}`} type="button" onClick={toggleFocusMode}>{focusMode ? "Фиксированный" : "Свободный"}</button>
          <span className="canvas-controls-divider" />
          <button type="button" aria-label="Уменьшить масштаб" onClick={() => zoomBy(1 / 1.12)}>−</button>
          <span className="canvas-zoom">{Math.round((camera?.zoom ?? 0.9) * 100)}%</span>
          <button type="button" aria-label="Увеличить масштаб" onClick={() => zoomBy(1.12)}>＋</button>
        </div>
        {board && <button className="session-archive-link" type="button" onClick={() => setShowSessionArchive(true)}>Архив сессий{archivedLanes.length > 0 ? ` · ${archivedLanes.length}` : ""}</button>}
        {showSessionArchive && <div className="session-archive-backdrop" role="presentation" onClick={() => setShowSessionArchive(false)}><section className="session-archive-dialog" role="dialog" aria-modal="true" aria-label="Архив сессий" onClick={(event) => event.stopPropagation()}><div><h2>Архив сессий</h2><button type="button" onClick={() => setShowSessionArchive(false)} aria-label="Закрыть">×</button></div><input className="archive-search" type="search" value={archiveSearch} onChange={(event) => setArchiveSearch(event.target.value)} placeholder="Поиск по сессиям" aria-label="Поиск по архиву" />{archivedLanes.length === 0 && <p>Архив пуст.</p>}{archivedLanes.filter((lane) => lane.title.toLocaleLowerCase("ru-RU").includes(archiveSearch.toLocaleLowerCase("ru-RU"))).map((lane) => <div className="archive-item" key={lane.id}><span>{lane.title}</span><button type="button" onClick={() => void archiveLane(lane.id, false)}>Восстановить</button><button type="button" aria-label={`Удалить сессию ${lane.title}`} title="Удалить сессию" onClick={() => void deleteLane(lane.id, lane.title)}><Icon name="trash" /></button></div>)}</section></div>}
      </section>}
      {confirmation && createPortal(<ConfirmationDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.onConfirm; setConfirmation(null); void action(); }} />, document.body)}
    </main>
  );
}

function DemoPipelineScreen({ boardId }: { boardId: string }) {
  const [query, setQuery] = useState("обмен книгами");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DemoPipelineResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPipeline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || running) return;
    setResult(null);
    setError(null);
    setRunning(true);
    try {
      setResult(await readJson<DemoPipelineResult>(`/api/boards/${encodeURIComponent(boardId)}/demo-pipeline`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: query.trim() }),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить цепочку MCP-инструментов");
    } finally {
      setRunning(false);
    }
  }

  return <section className="demo-pipeline-screen" aria-label="Демонстрация цепочки MCP">
    <div className="demo-pipeline-content">
      <header className="demo-pipeline-heading">
        <span className="demo-pipeline-eyebrow">День 19 · MCP</span>
        <h1>Один запрос, три инструмента</h1>
        <p>Сервер выполняет поиск, передаёт найденные данные инструменту сводки и сохраняет её в локальный файл. Ни один шаг не подменён ответом модели.</p>
      </header>
      <form className="demo-pipeline-form" onSubmit={(event) => void runPipeline(event)}>
        <label htmlFor="demo-pipeline-query">Что искать</label>
        <div><input id="demo-pipeline-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={120} placeholder="Например, книжный обмен" required />
          <button type="submit" disabled={running || !query.trim()}>{running ? "Выполняется…" : "Запустить цепочку"}</button></div>
      </form>
      {error && <p className="demo-pipeline-error" role="alert">{error}</p>}
      {running && <p className="demo-pipeline-progress" role="status">Инструменты выполняются по очереди. Результаты появятся после завершения.</p>}
      <div className="demo-pipeline-steps">
        {([ ["demo-events", "search_events", "Получить данные"], ["demo-events", "summarize_events", "Сделать сводку"], ["demo-notes", "save_summary", "Сохранить результат"] ] as const).map(([serverId, toolName, title], index) => {
          const step = result?.steps[index];
          return <article className={`demo-pipeline-step ${step ? "completed" : ""}`} key={toolName}>
            <div className="demo-pipeline-step-heading"><span className="demo-pipeline-number">{index + 1}</span><div><h2>{title}</h2><small>{serverId} / {toolName}</small></div><span className="demo-pipeline-step-state">{step ? "Готово" : "Ожидает запуска"}</span></div>
            {step && <div className="demo-pipeline-data"><div><strong>Входные параметры</strong><pre>{JSON.stringify(step.arguments, null, 2)}</pre></div><div><strong>Ответ MCP</strong><pre>{JSON.stringify(step.result.structuredContent ?? step.result, null, 2)}</pre></div></div>}
          </article>;
        })}
      </div>
      {result && <div className="demo-pipeline-output" role="status"><strong>Цепочка завершена</strong><pre>{JSON.stringify(result.output, null, 2)}</pre></div>}
    </div>
  </section>;
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

function ConfirmationDialog({ confirmation, onCancel, onConfirm }: { confirmation: Confirmation; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);
  return <div className="confirmation-backdrop" role="presentation" onClick={onCancel}>
    <section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" onClick={(event) => event.stopPropagation()}>
      <h2 id="confirmation-title">{confirmation.title}</h2>
      <p id="confirmation-description">{confirmation.description}</p>
      <div className="confirmation-actions">
        <button ref={cancelRef} type="button" onClick={onCancel}>Отмена</button>
        <button className="confirmation-primary" type="button" onClick={onConfirm}>{confirmation.confirmLabel}</button>
      </div>
    </section>
  </div>;
}

function JsonCode({ value }: { value: unknown }) {
  const source = JSON.stringify(value, null, 2) ?? "{}";
  return <pre className="request-code"><code>{tokenizeJson(source).map((token, index) => <span className={`json-${token.kind}`} key={index}>{token.text}</span>)}</code></pre>;
}

function RunDetailPanel({ item, onCopy }: { item: Message; onCopy: (text: string) => void }) {
  const details = item.technicalDetails ?? {};
  const duration = typeof details.durationMs === "number" ? `${(details.durationMs / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с` : null;
  const configured = item.requestConfig ?? {};
  const request = details.request ?? { model: configured.model ?? "по умолчанию", ...(configured.effort ? { effort: configured.effort } : {}), ...(configured.serviceTier ? { serviceTier: configured.serviceTier } : {}), stream: true };
  const toolCalls = Array.isArray(details.toolCalls) ? details.toolCalls : [];
  return <details className="run-details">
    <summary>{item.runStatus === "running" ? "Выполняется" : item.runStatus === "failed" ? "Запрос завершился с ошибкой" : `Выполнена${duration ? ` за ${duration}` : ""}`} <Icon name="chevron" size={14} /></summary>
    <div className="detail-line"><div className="detail-heading"><strong>Запрос к LLM</strong><button type="button" aria-label="Копировать запрос" title="Копировать запрос" onClick={(event) => { event.preventDefault(); onCopy(JSON.stringify(request, null, 2)); }}><Icon name="copy" /></button></div><JsonCode value={request} /></div>
    {toolCalls.length > 0 && <div className="detail-line"><strong>Использование инструментов</strong>{toolCalls.map((tool, index) => <div className="tool-use" key={index}><JsonCode value={tool} /></div>)}</div>}
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

function BoardTaskOverview({ boardId, open, onToggle }: { boardId: string; open: boolean; onToggle: (open: boolean) => void }) {
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
  return <details className="board-tasks" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
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
type ScheduleRun = { id: string; scheduleId: string; title: string; scheduledFor: number; startedAt?: number; status: string; missedCount: number; result?: { sampleCount?: number; total?: number; average?: number; minimum?: number; maximum?: number; source?: string; runId?: string }; error?: string };

function BoardScheduleOverview({ boardId, agentLaneId, open, onToggle, onConfirmAction }: { boardId: string; agentLaneId?: string; open: boolean; onToggle: (open: boolean) => void; onConfirmAction: (title: string, description: string, confirmLabel: string, onConfirm: () => Promise<void>) => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [title, setTitle] = useState("Сводка метрик");
  const [firstDelay, setFirstDelay] = useState(2000);
  const [repeatEvery, setRepeatEvery] = useState<number | null>(null);
  const [agentPrompt, setAgentPrompt] = useState("Вызови MCP-инструмент lookup_demo_event с eventId spring-book-swap. По результату инструмента составь короткую сводку события. Не добавляй неподтверждённых фактов.");
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
      await readJson<Schedule>(`${base}/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, delayMs: firstDelay, repeatEveryMs: repeatEvery, ...(agentLaneId ? { agentLaneId, agentPrompt } : {}) }) });
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
  function remove(schedule: Schedule) {
    onConfirmAction(`Удалить расписание «${schedule.title}»?`, "Расписание и его история запусков будут удалены. Сообщения агента останутся в ленте.", "Удалить расписание", async () => {
      setError(null);
      try {
        const response = await fetch(`${base}/schedules/${encodeURIComponent(schedule.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `HTTP ${response.status}`);
        await refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось удалить расписание"); }
    });
  }
  function clearHistory() {
    onConfirmAction("Очистить историю запусков?", "Завершённые запуски этой доски будут удалены. Расписания, текущий запуск и сообщения агента останутся.", "Очистить историю", async () => {
      setError(null);
      try {
        await readJson<{ deleted: number }>(`${base}/schedule-runs`, { method: "DELETE" });
        await refresh();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось очистить историю запусков"); }
    });
  }
  const date = (timestamp: number) => new Date(timestamp).toLocaleTimeString();
  return <details className="board-schedules" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
    <summary>Локальные расписания · {agentLaneId ? "запуск агента" : "сводка демо-метрик"}</summary>
    <div className="board-schedules-content">
      <p>Сервис выполняет расписания, пока работает backend, даже если браузер закрыт. {agentLaneId ? "Ответ агента появится в ленте автоматически. Интервал повтора отсчитывается после завершения ответа модели." : "Интервал повтора отсчитывается после завершения задачи."}</p>
      <form className="schedule-create-form" onSubmit={(event) => void create(event)}>
        <input aria-label="Название расписания" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
        {agentLaneId && <label className="schedule-agent-prompt">Задание агенту<textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} maxLength={2000} rows={4} required /></label>}
        <label>Старт через<select value={firstDelay} onChange={(event) => setFirstDelay(Number(event.target.value))}><option value={250}>0,25 с</option><option value={1000}>1 с</option><option value={2000}>2 с</option><option value={5000}>5 с</option><option value={60000}>1 мин</option></select></label>
        <label>Повтор<select value={repeatEvery ?? "once"} onChange={(event) => setRepeatEvery(event.target.value === "once" ? null : Number(event.target.value))}><option value="once">Один раз</option><option value={1000}>Каждую 1 с</option><option value={2000}>Каждые 2 с</option><option value={5000}>Каждые 5 с</option><option value={60000}>Каждую минуту</option></select></label>
        <button type="submit" disabled={!title.trim() || Boolean(agentLaneId && !agentPrompt.trim())}>Создать</button>
      </form>
      {error && <p className="schedule-error" role="alert">{error}</p>}
      <div className="schedule-list">{schedules.length === 0 && <p>Расписаний пока нет.</p>}{schedules.map((schedule) => <article className="schedule-card" key={schedule.id}>
        <strong>{schedule.title}</strong><span>{schedule.status === "paused" ? "приостановлено" : schedule.status === "running" ? "выполняется" : schedule.status === "completed" ? "завершено" : `следующий запуск: ${date(schedule.nextRunAt)}`}</span>
        <div className="schedule-card-actions">
          {schedule.status !== "completed" && <button type="button" onClick={() => void pause(schedule)}>{schedule.status === "paused" ? "Возобновить" : "Пауза"}</button>}
          <button className="schedule-delete" type="button" onClick={() => remove(schedule)} disabled={schedule.status === "running"} aria-label={`Удалить расписание «${schedule.title}»`} title={schedule.status === "running" ? "Дождись завершения запуска" : "Удалить расписание"}><Icon name="trash" size={14} /></button>
        </div>
      </article>)}</div>
      <div className="schedule-history-heading"><h4>История запусков</h4><button type="button" onClick={clearHistory} disabled={runs.length === 0}>Очистить историю</button></div>
      <div className="schedule-runs">{runs.length === 0 && <p>Результатов пока нет.</p>}{runs.slice(0, 12).map((run) => <article className="schedule-run" key={run.id}>
        <strong>{run.title}</strong><span>{run.status} · {date(run.startedAt ?? run.scheduledFor)}{run.missedCount > 0 ? ` · пропущено слотов: ${run.missedCount}` : ""}</span>
        {run.result?.source === "scheduled-agent" && <span>Агент завершил ответ в ленте · запуск {run.result.runId?.slice(0, 8)}.</span>}
        {run.result && run.result.source !== "scheduled-agent" && <span>n={run.result.sampleCount}, сумма {run.result.total}, среднее {run.result.average?.toFixed(1)}, min/max {run.result.minimum}/{run.result.maximum}</span>}{run.error && <span className="schedule-error">{run.error}</span>}
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

function LaneView({ lane, boardInstructions, agentName, lanes, authenticated, openRouterConfigured, codexModels, mcpServers, onRefresh, onBranch, onClone, onSelect, onSaveLayout, onPreviewMove, onCopy, onMutate, onSaveConfig, onSaveInstructions, onSaveMcpTools, onSaveSkills, onSaveSubagents, onAutoApprove, onApproval, onEditFact, onClearFacts, onCancelRun, selected, zoom, cameraY, groupColor, isGroupRoot, inColorGroup, hasBranches, onRename, onArchive, onDelete, onChooseProvider, colorDraft, onColorDraft, onApplyColor, onConfirmAction }: {
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
  onPreviewMove: (dx: number, dy: number) => void;
  onCopy: (messageId: string, targetLaneId: string) => void;
  onMutate: (messageId: string, content: string | null) => Promise<void>;
  onSaveConfig: (config: Pick<Lane, "model" | "temperature" | "maxTokens" | "stop" | "contextStrategy" | "contextWindowSize" | "contextBudgetTokens" | "effort" | "serviceTier">) => void;
  onSaveInstructions: (instructions: string, mode: Lane["instructionMode"]) => void;
  onSaveMcpTools: (tools: Lane["mcpTools"]) => void;
  onSaveSkills: (skills: string[]) => void;
  onSaveSubagents: (expanded: boolean, pinnedIds: string[]) => void;
  onAutoApprove: (enabled: boolean) => void;
  onApproval: (approvalId: string, decision: "approve" | "deny" | "close_uncertain") => void;
  onEditFact: (key: string, value: string | null) => void;
  onClearFacts: () => void;
  onCancelRun: (runId: string) => void;
  selected: boolean;
  zoom: number;
  cameraY: number;
  groupColor: string;
  isGroupRoot: boolean;
  inColorGroup: boolean;
  hasBranches: boolean;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  onChooseProvider: (provider: Lane["provider"]) => void;
  colorDraft: string | null;
  onColorDraft: (value: string | null) => void;
  onApplyColor: (value: string) => void;
  onConfirmAction: (title: string, description: string, confirmLabel: string, onConfirm: () => void | Promise<void>) => void;
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
  const [config, setConfig] = useState({ model: lane.model, effort: lane.effort ?? "", serviceTier: lane.serviceTier ?? "", temperature: lane.temperature ?? 0.7, maxTokens: lane.maxTokens ?? 2048, stop: lane.stop ?? "", contextStrategy: lane.contextStrategy, contextWindowSize: lane.contextWindowSize, contextBudgetTokens: lane.contextBudgetTokens });
  const [modelOpen, setModelOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [subagentsDialogOpen, setSubagentsDialogOpen] = useState(false);
  const [pinnedDraft, setPinnedDraft] = useState<string[]>([]);
  const [settingsTab, setSettingsTab] = useState<"instructions" | "parameters" | "skills" | "mcp" | "other">("instructions");
  const [mcpSearch, setMcpSearch] = useState("");
  const [instructionDraft, setInstructionDraft] = useState(lane.instructions);
  const [instructionMode, setInstructionMode] = useState<Lane["instructionMode"]>(lane.instructionMode);
  const [forceSend, setForceSend] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [toolEvents, setToolEvents] = useState<Array<Record<string, unknown>>>([]);
  const [newFactKey, setNewFactKey] = useState("");
  const [newFactValue, setNewFactValue] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(lane.title);
  const [colorOpen, setColorOpen] = useState(false);
  const laneRef = useRef<HTMLElement>(null);
  const [laneHeight, setLaneHeight] = useState(0);
  useLayoutEffect(() => {
    const element = laneRef.current;
    if (!element) return;
    const measure = () => setLaneHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const providerReady = lane.providerChosen !== false && (lane.provider === "codex" ? authenticated : openRouterConfigured);
  const subagents = lanes.filter((item) => item.originKind === "subagent" && item.originLaneId === lane.id)
    .sort((a, b) => Number(Boolean(b.activeRun)) - Number(Boolean(a.activeRun)) || Number(Boolean(b.subagentPinned)) - Number(Boolean(a.subagentPinned)) || (b.launchOrder ?? 0) - (a.launchOrder ?? 0));

  function persistConfig(next = config) {
    onSaveConfig(lane.provider === "codex" ? {
      model: next.model,
      effort: next.effort,
      serviceTier: next.serviceTier,
      contextStrategy: next.contextStrategy,
      contextWindowSize: next.contextWindowSize,
      contextBudgetTokens: next.contextBudgetTokens,
    } : next);
  }

  useEffect(() => setLayout({ x: lane.x, y: lane.y, width: lane.width }), [lane.x, lane.y, lane.width]);
  useEffect(() => { setInstructionDraft(lane.instructions); setInstructionMode(lane.instructionMode); }, [lane.instructions, lane.instructionMode]);
  useEffect(() => setConfig({ model: lane.model, effort: lane.effort ?? "", serviceTier: lane.serviceTier ?? "", temperature: lane.temperature ?? 0.7, maxTokens: lane.maxTokens ?? 2048, stop: lane.stop ?? "", contextStrategy: lane.contextStrategy, contextWindowSize: lane.contextWindowSize, contextBudgetTokens: lane.contextBudgetTokens }), [lane.model, lane.effort, lane.serviceTier, lane.temperature, lane.maxTokens, lane.stop, lane.contextStrategy, lane.contextWindowSize, lane.contextBudgetTokens]);

  const selectedModel = codexModels.find((item) => (item.model ?? item.id ?? item.slug) === config.model) ?? codexModels.find((item) => item.isDefault);
  const modelLabel = (selectedModel?.displayName ?? config.model) || "Модель";
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const effectiveEffort = config.effort || selectedModel?.defaultReasoningEffort || "medium";
  const effortLabels: Record<string, string> = { none: "Без рассуждения", minimal: "Минимальный", low: "Низкий", medium: "Средний", high: "Высокий", xhigh: "Очень высокий", max: "Максимальный", ultra: "Ультра" };

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

  function openSubagentsSettings() {
    setPinnedDraft(subagents.filter((item) => item.subagentPinned).map((item) => item.id));
    setSubagentsDialogOpen(true);
  }

  const listenToRun = useCallback((id: string, after: number) => {
    sourceRef.current?.close();
    const source = new EventSource(`/api/runs/${id}/events?after=${after}`);
    sourceRef.current = source;
    source.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as RunEvent;
      setRunState((current) => applyRunEvent(current, data));
      if (data.type === "tool.started") {
        setToolEvents((current) => applyToolRunEvent(current, data));
        if (data.data.serverId === "ai-advent-subagents") void onRefresh();
      }
      if (data.type === "tool.completed") {
        setToolEvents((current) => applyToolRunEvent(current, data));
        if (data.data.serverId === "ai-advent-subagents") void onRefresh();
      }
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

  useEffect(() => {
    if (lane.activeRun || !lane.queuedMessages?.some((item) => item.status === "pending")) return;
    const timer = window.setInterval(() => { void onRefresh(); }, 1_000);
    return () => window.clearInterval(timer);
  }, [lane.activeRun, lane.queuedMessages, onRefresh]);

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
        x: Math.max(0, origin.x + (moveEvent.clientX - startX) / zoom),
        y: Math.max(0, origin.y + (moveEvent.clientY - startY) / zoom),
      };
      layoutRef.current = next;
      setLayout(next);
      if (isGroupRoot && hasBranches) onPreviewMove(next.x - origin.x, next.y - origin.y);
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
    const move = (moveEvent: PointerEvent) => {
      const next = { ...layoutRef.current, width: Math.min(900, Math.max(560, initialWidth + (moveEvent.clientX - startX) / zoom)) };
      layoutRef.current = next;
      setLayout(next);
      if (isGroupRoot && hasBranches) onPreviewMove(next.width - initialWidth, 0);
    };
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
    onConfirmAction("Сохранить изменения?", "Все более поздние сообщения в этой ленте будут удалены. Уже созданные ветки и клоны сохранят прежнюю историю.", "Сохранить изменения", async () => {
      await onMutate(messageId, editedContent.trim());
      setEditingMessageId(null);
    });
  }

  async function deleteTail(messageId: string) {
    onConfirmAction("Удалить сообщения?", "Это сообщение и все более поздние сообщения в этой ленте будут удалены. Уже созданные ветки и клоны сохранят прежнюю историю.", "Удалить сообщения", () => onMutate(messageId, null));
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitMessage(false);
  }

  async function submitMessage(queued: boolean) {
    const runningNow = Boolean(lane.activeRun) || runState.status === "running";
    if (!message.trim() || (!queued && runningNow)) return;
    const text = message.trim();
    setMessage("");
    if (textareaRef.current) resizeTextarea(textareaRef.current);
    if (!queued) {
      setError(null);
      setRunState(emptyRunState());
      setToolEvents([]);
    }
    try {
      const parameters = {
        model: config.model,
        effort: lane.provider === "codex" ? config.effort : undefined,
        serviceTier: lane.provider === "codex" ? config.serviceTier : undefined,
        temperature: lane.provider === "openrouter" ? config.temperature : undefined,
        maxTokens: lane.provider === "openrouter" ? config.maxTokens : undefined,
        stop: lane.provider === "openrouter" ? config.stop : undefined,
        contextStrategy: config.contextStrategy,
        contextWindowSize: config.contextWindowSize,
        contextBudgetTokens: config.contextBudgetTokens,
        skillIds: lane.skills ?? [],
      };
      const result = await readJson<{ runId?: string; queueId?: string; queued: boolean }>(`/api/lanes/${lane.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, queued, parameters: { ...parameters, forceSend } }),
      });
      const updated = await onRefresh();
      const latestLane = updated.lanes.find((item) => item.id === lane.id);
      const active = latestLane?.activeRun;
      if (result.queued) {
        if (!runningNow && active?.id) {
          setRunId(active.id);
          const savedAnswer = latestLane?.messages.find((item) => item.role === "assistant" && item.runStatus === "running")?.content ?? "";
          setRunState({ sequence: active.sequence, status: "running", answer: savedAnswer, error: null });
          listenToRun(active.id, active.sequence);
        }
        return;
      }
      if (!result.runId) throw new Error("Сервер не вернул идентификатор запуска.");
      setRunId(result.runId);
      const savedAnswer = latestLane?.messages.find((item) => item.role === "assistant" && item.runStatus === "running")?.content ?? "";
      const sequence = active?.sequence ?? 0;
      setRunState({ sequence, status: "running", answer: savedAnswer, error: null });
      listenToRun(result.runId, sequence);
    } catch (cause) {
      setMessage(text);
      if (!queued) setRunState({ ...emptyRunState(), status: "failed", error: cause instanceof Error ? cause.message : "Ошибка запроса" });
      setError(cause instanceof Error ? cause.message : "Ошибка запроса");
    }
  }

  const running = Boolean(lane.activeRun) || runState.status === "running";

  return (
    <article ref={laneRef} className={`lane ${selected ? "selected" : ""} ${inColorGroup ? "grouped" : ""} ${lane.originKind === "subagent" ? "subagent-lane" : ""}`} data-lane-id={lane.id} style={{ left: layout.x, top: layout.y, width: layout.width, "--group-color": groupColor } as CSSProperties}>
      <header className="lane-heading" style={{ transform: `translateY(${stickyHeaderOffset(cameraY, zoom, layout.y, laneHeight)}px)` }} onClick={onSelect}>
        {lane.originKind !== "branch" && lane.originKind !== "subagent" && <span className="lane-grip" onPointerDown={startMove} aria-label="Перетащить сессию" title="Перетащить сессию"><Icon name="grip" /></span>}
        {editingTitle ? <input className="lane-title-input" aria-label="Название сессии" autoFocus value={titleDraft} maxLength={120} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (titleDraft.trim()) onRename(titleDraft); setEditingTitle(false); } else if (event.key === "Escape") { setTitleDraft(lane.title); setEditingTitle(false); } }} onBlur={() => { if (titleDraft.trim() && titleDraft !== lane.title) onRename(titleDraft); setEditingTitle(false); }} /> : <h2 onDoubleClick={() => { setTitleDraft(lane.title); setEditingTitle(true); }} title="Двойной щелчок — изменить название">{lane.title}</h2>}
        <div className="lane-header-actions">
          {subagents.length > 0 && <div className="subagent-controls">
            <button className="lane-header-icon subagent-toggle" type="button" aria-expanded={Boolean(lane.subagentsExpanded)}
              aria-label={`${lane.subagentsExpanded ? "Скрыть" : "Показать"} сабагентов · ${subagents.length}`}
              title={`${lane.subagentsExpanded ? "Скрыть" : "Показать"} сабагентов · ${subagents.length}`}
              onClick={(event) => { event.stopPropagation(); onSaveSubagents(!lane.subagentsExpanded, subagents.filter((item) => item.subagentPinned).map((item) => item.id)); }}>
              <Icon name="chevron" size={15} />
            </button>
            <button className="lane-header-icon" type="button" aria-label="Настроить сабагентов" title="Настроить сабагентов"
              onClick={(event) => { event.stopPropagation(); openSubagentsSettings(); }}><Icon name="settings" size={14} /></button>
          </div>}
          {isGroupRoot && hasBranches && <div className="group-color-control"><button className="group-color-trigger" type="button" aria-label={`Цвет группы: ${groupColor}`} aria-expanded={colorOpen} onClick={() => { if (colorOpen) { onColorDraft(null); setColorOpen(false); } else { onColorDraft(lane.groupColor ?? "#9fb7d3"); setColorOpen(true); } }}><span /></button>
            {colorOpen && <div className="group-color-popover" role="dialog" aria-label="Цвет группы" onClick={(event) => event.stopPropagation()}><strong>Цвет группы</strong><div className="group-color-palette">{["#9fb7d3", "#a8cbb5", "#d9bbad", "#d4c49e", "#beaeca", "#9cc7c8"].map((value) => <button type="button" key={value} aria-label={`Цвет ${value}`} aria-pressed={groupColor === value} style={{ background: value }} onClick={() => onColorDraft(value)} />)}</div><label>Свой цвет <input aria-label="Свой цвет группы" type="color" value={groupColor} onChange={(event) => onColorDraft(event.target.value)} /></label><div className="group-color-actions"><button type="button" onClick={() => { onColorDraft(null); setColorOpen(false); }}>Отмена</button><button type="button" onClick={() => { onApplyColor(colorDraft ?? groupColor); setColorOpen(false); }}>Применить</button></div></div>}
          </div>}
          <button className="lane-header-icon" type="button" onClick={onClone} disabled={running} aria-label="Клонировать сессию" title="Клонировать сессию"><Icon name="copy" /></button>
          <button className="lane-header-icon" type="button" onClick={onArchive} disabled={running} aria-label="В архив" title="В архив"><Icon name="archive" /></button>
          <button className="lane-header-icon" type="button" onClick={onDelete} disabled={running} aria-label="Удалить сессию" title="Удалить сессию"><Icon name="trash" /></button>
        </div>
      </header>
      {subagentsDialogOpen && createPortal(<div className="settings-backdrop" role="presentation" onClick={() => setSubagentsDialogOpen(false)}>
        <form className="subagents-dialog" role="dialog" aria-modal="true" aria-label={`Сабагенты · ${lane.title}`} onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => { event.preventDefault(); onSaveSubagents(Boolean(lane.subagentsExpanded), pinnedDraft); setSubagentsDialogOpen(false); }}>
          <div className="settings-heading"><h2>Сабагенты · {lane.title}</h2><button type="button" aria-label="Закрыть настройки сабагентов" onClick={() => setSubagentsDialogOpen(false)}>×</button></div>
          <p>При раскрытии видны активные сабагенты. Завершённые остаются на доске, если их закрепить.</p>
          <div className="subagent-list">{subagents.map((child) => {
            const active = Boolean(child.activeRun);
            const failed = child.messages.some((item) => item.role === "assistant" && item.runStatus === "failed");
            const checked = pinnedDraft.includes(child.id);
            return <label className="subagent-item" data-active={active} key={child.id}>
              <span><strong>{child.title}</strong><small className={`agent-status ${active ? "active" : ""}`}>{active ? "Активен" : failed ? "Ошибка" : "Завершён"}</small></span>
              <span className={`subagent-pin ${checked ? "is-pinned" : ""}`}><input type="checkbox" aria-label={`Закрепить ${child.title}`} checked={checked}
                onChange={(event) => setPinnedDraft((current) => event.target.checked ? [...current, child.id] : current.filter((id) => id !== child.id))} />
                <Icon name="pin" size={16} /></span>
            </label>;
          })}</div>
          <div className="dialog-actions"><button type="button" onClick={() => setSubagentsDialogOpen(false)}>Отмена</button><button type="submit">Сохранить</button></div>
        </form>
      </div>, document.body)}
      {lane.providerChosen !== false && settingsOpen && createPortal(<div className="settings-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}><section className="session-settings-dialog" role="dialog" aria-modal="true" aria-label={`Настройки сессии ${lane.title}`} onClick={(event) => event.stopPropagation()}>
        <div className="settings-heading"><h2>Настройки сессии</h2><button type="button" aria-label="Закрыть настройки" onClick={() => setSettingsOpen(false)}>×</button></div>
        <div className="settings-tabs" role="tablist" aria-label="Раздел настроек">
          {([ ["instructions", lane.provider === "codex" ? "AGENTS.md" : "Системный промпт"], ["parameters", "Параметры"], ["skills", "Skills"], ["mcp", "MCP"], ["other", "Дополнительно"] ] as const).map(([tab, label]) => <button type="button" key={tab} role="tab" aria-selected={settingsTab === tab} className={settingsTab === tab ? "active" : ""} onClick={() => setSettingsTab(tab)}>{label}</button>)}
        </div>
        <div className="settings-panel" role="tabpanel">
        {settingsTab === "parameters" && <label>Модель
          {lane.provider === "codex" && codexModels.length > 0 ? (
            <select value={config.model} onChange={(event) => { const next = { ...config, model: event.target.value }; setConfig(next); persistConfig(next); }}>
              <option value="">Модель Codex по умолчанию</option>
              {codexModels.map((model) => {
                const id = model.model ?? model.id ?? model.slug;
                return id && <option key={id} value={id}>{model.displayName ?? id}{model.isDefault ? " · по умолчанию" : ""}</option>;
              })}
            </select>
          ) : <input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} onBlur={() => persistConfig()} aria-label="Модель" />}
        </label>}
        {settingsTab === "instructions" && <section className="lane-instructions">
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
        </section>}
        {settingsTab === "parameters" && lane.provider === "openrouter" && <>
          <label>Temperature<input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={(event) => setConfig({ ...config, temperature: Number(event.target.value) })} onBlur={() => persistConfig()} /></label>
          <label>Максимум токенов<input type="number" min="1" max="200000" step="1" value={config.maxTokens} onChange={(event) => setConfig({ ...config, maxTokens: Number(event.target.value) })} onBlur={() => persistConfig()} /></label>
          <label>Stop<input value={config.stop} onChange={(event) => setConfig({ ...config, stop: event.target.value })} onBlur={() => persistConfig()} /></label>
        </>}
        {settingsTab === "skills" && <section className="session-skills">
          <strong>Навыки сессии</strong>
          <p>Выбранные правила добавляются к инструкциям следующего запроса. Они не включают отсутствующие инструменты и не заменяют серверные проверки.</p>
          {SESSION_SKILLS.map((skill) => <label className="session-skill" key={skill.id}>
            <input type="checkbox" checked={(lane.skills ?? []).includes(skill.id)} disabled={running}
              onChange={(event) => {
                const selected = new Set(lane.skills ?? []);
                if (event.target.checked) selected.add(skill.id); else selected.delete(skill.id);
                onSaveSkills([...selected]);
              }} />
            <span><b>{skill.name}</b><small>{skill.description}</small></span>
          </label>)}
        </section>}
        {settingsTab === "mcp" && <section className="mcp-tools">
          <label className="mcp-search">Поиск MCP<input type="search" value={mcpSearch} onChange={(event) => setMcpSearch(event.target.value)} placeholder="Найти сервер или инструмент…" /></label>
          <p>{lane.mcpTools.length} инструментов разрешено</p>
          {lane.provider === "codex" && <p className="capability-gate">Codex app-server не подтверждает доступ ленты к этим MCP-инструментам. Реальное выполнение сейчас поддержано только через OpenRouter.</p>}
          {mcpServers.filter((server) => `${server.name} ${server.description} ${server.tools.map((tool) => `${tool.name} ${tool.description}`).join(" ")}`.toLocaleLowerCase("ru-RU").includes(mcpSearch.toLocaleLowerCase("ru-RU"))).map((server) => <details className="mcp-server" key={server.id}>
            <summary><strong>{server.name}</strong><span>{server.tools.filter((tool) => lane.mcpTools.some((item) => item.serverId === server.id && item.toolName === tool.name)).length}/{server.tools.length} инструментов</span><Icon name="chevron" /></summary>
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
          </details>)}
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
            {approval.status === "pending" && <><p>Действие ещё не выполнено; {approval.serverId === "board-memory" ? "память не изменена" : "результат не сохранён"}.</p>
              <button type="button" onClick={() => onApproval(approval.id, "approve")}>Подтвердить</button>
              <button type="button" onClick={() => onApproval(approval.id, "deny")}>Отклонить</button></>}
            {approval.status === "uncertain" && <><p>Выполнение прервалось. Внешнее действие могло выполниться; автоматического повтора не будет. Проверь результат вручную, затем закрой эту запись.</p>
              <button type="button" onClick={() => onApproval(approval.id, "close_uncertain")}>Закрыть после ручной проверки</button></>}
            {approval.status === "uncertain_closed" && <p>Запись закрыта вручную. Исход внешнего действия остаётся неизвестным.</p>}
          </section>)}
        </section>}
        {settingsTab === "other" && <><label>История
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
        </section>}</>}
        </div><div className="settings-actions"><button type="button" onClick={() => setSettingsOpen(false)}>Готово</button></div>
      </section></div>, document.body)}
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
        {lane.messages.filter((item) => !(item.role === "assistant" && item.runStatus === "running")).map((item) => {
          const index = lane.messages.findIndex((entry) => entry.id === item.id);
          const previousConfig = [...lane.messages.slice(0, index)].reverse().find((entry) => entry.role === "assistant")?.requestConfig ?? null;
          const nextConfig = lane.messages.slice(index + 1).find((entry) => entry.role === "assistant")?.requestConfig ?? null;
          const changed = item.role === "user" && wasConfigurationChanged(previousConfig, nextConfig);
          return <article className={`message ${item.role}`} key={item.id} data-message-id={item.id}>
            {item.role === "assistant" && item.requestConfig && <RunDetailPanel item={item} onCopy={copyText} />}
            {changed && <span className="message-config-note"><Icon name="settings" size={13} /> Настройки изменены</span>}
            <div className="message-content">
              {editingMessageId === item.id ? (
                <div className="message-editor">
                  <textarea value={editedContent} onChange={(event) => setEditedContent(event.target.value)} aria-label="Изменить сообщение" />
                  <button type="button" onClick={() => void saveEdit(item.id)}>Сохранить и удалить хвост</button>
                  <button type="button" onClick={() => setEditingMessageId(null)}>Отмена</button>
                </div>
              ) : <MarkdownContent content={item.content} />}
            </div>
            {item.provenance && <small className="message-provenance">{item.provenance}</small>}
            {item.runStatus === "failed" && <p className="message-error">{item.runError ?? "Ответ не завершён."}</p>}
            <div className="message-actions">
              {item.hasBranches && <span className="branch-existing">Есть ветка</span>}
              <button type="button" onClick={() => void copyText(item.content)} aria-label="Копировать текст" title="Копировать текст"><Icon name="copy" /></button>
              <button type="button" onClick={() => onBranch(item.id)} disabled={running} aria-label="Создать ветку отсюда" title="Создать ветку отсюда"><Icon name="branch" /></button>
              <button type="button" onClick={() => { setEditingMessageId(item.id); setEditedContent(item.content); }} disabled={running} aria-label="Изменить сообщение" title="Изменить сообщение"><Icon name="edit" /></button>
              <button type="button" onClick={() => void deleteTail(item.id)} disabled={running} aria-label="Удалить сообщение с хвостом" title="Удалить сообщение с хвостом"><Icon name="trash" /></button>
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
          </article>;
        })}
        {runId && runState.status === "running" && runState.answer && (
                <article className="message assistant streaming" aria-label="Ответ модели поступает">
            <div className="message-label">{lane.provider.toUpperCase()} · ОТВЕТ</div>
          <MarkdownContent content={runState.answer} /><span className="cursor" />
          </article>
        )}
        {(lane.queuedMessages ?? []).map((queued) => <div className={`queue-event ${queued.status === "failed" ? "queue-failed" : ""}`} key={queued.id}>
          <span className="queue-dot" /><span><strong>{queued.status === "pending" ? "В очереди" : "Не запущено"}</strong> · {queued.content}{queued.error && <small>{queued.error}</small>}</span>
        </div>)}
        {lane.providerChosen === false ? <div className="provider-choice"><strong>С чего начнём?</strong><p>Выбери провайдера для новой сессии.</p><div><button type="button" onClick={() => onChooseProvider("codex")}>Codex</button><button type="button" onClick={() => onChooseProvider("openrouter")}>OpenRouter</button></div></div> : lane.messages.length === 0 && !(lane.queuedMessages?.length) && !running && <div className="empty-state"><span className="empty-symbol">✳</span><p>Сессия пуста</p><span>Начни с сообщения внизу.</span></div>}
      </div>
      {error && <p className="lane-error" role="alert">{error}</p>}
      {runState.status === "failed" && runState.error && !error && <p className="lane-error" role="alert">{runState.error}</p>}
      {lane.providerChosen !== false && <><div className="provider-label">{lane.provider === "codex" ? "Codex" : "OpenRouter"}</div><form className="composer" onSubmit={(event) => void sendMessage(event)}>
        <details className="context-plan-details"><summary>Состав отправляемого запроса</summary>
          <div className="context-estimate" aria-live="polite">
            <span>Текущее сообщение: ~{contextPlan.currentMessageTokensEstimate} токенов</span>
            <span>История после: ~{contextPlan.historyTokensEstimate}; до сжатия: ~{beforeCompression.historyTokensEstimate}</span>
            <span>Вход: ~{contextPlan.inputTokensEstimate} + ответ ~{contextPlan.responseTokensEstimate}; бюджет {contextPlan.budgetTokens}</span>
            {contextPlan.omittedMessages > 0 && <span>План сжимает историю на {contextPlan.omittedMessages} сообщений.</span>}
            {contextPlan.summaryMissing && <span className="context-warning">Сводка ещё не создана: старые сообщения останутся только в transcript и не попадут в запрос.</span>}
            {summaryStale && config.contextStrategy === "summary_window" && <span className="context-warning">Сводка устарела относительно transcript; обнови её явно.</span>}
          </div>
          <pre>{JSON.stringify(contextPlan.messages, null, 2)}</pre>
        </details>
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
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (event.shiftKey) void submitMessage(true);
              else event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          disabled={!providerReady}
        />
        <div className="composer-footer">
          {lane.provider === "codex" && <div className="model-widget">
            <button className="model-widget-trigger" type="button" aria-label={`Модель: ${modelLabel}; уровень рассуждения: ${effortLabels[effectiveEffort] ?? effectiveEffort}`} aria-expanded={modelOpen} onClick={() => setModelOpen(!modelOpen)}><span>{modelLabel}</span><span>{effortLabels[effectiveEffort] ?? effectiveEffort}</span></button>
            <button className={`speed-toggle ${config.serviceTier === "priority" ? "active" : ""}`} type="button" aria-label={`Скорость: ${config.serviceTier === "priority" ? "Быстрая" : "Обычная"}`} aria-pressed={config.serviceTier === "priority"} title={config.serviceTier === "priority" ? "Быстрая скорость" : "Обычная скорость"} disabled={!selectedModel?.serviceTiers?.some((tier) => tier.id === "priority")} onClick={() => { const next = { ...config, serviceTier: config.serviceTier === "priority" ? "" : "priority" }; setConfig(next); persistConfig(next); }}><Icon name="bolt" size={16} /></button>
            {modelOpen && <div className="model-popover" role="menu" aria-label="Модель и уровень рассуждения"><strong>Модель</strong><div className="model-options">{codexModels.map((item) => {
              const id = item.model ?? item.id ?? item.slug;
              if (!id) return null;
              return <button type="button" role="menuitemradio" key={id} aria-checked={id === config.model || (!config.model && item.isDefault)} onClick={() => { const supported = item.supportedReasoningEfforts?.map((value) => value.reasoningEffort) ?? []; const next = { ...config, model: id, effort: supported.includes(effectiveEffort) ? effectiveEffort : item.defaultReasoningEffort ?? supported[0] ?? "", serviceTier: item.serviceTiers?.some((tier) => tier.id === "priority") ? config.serviceTier : "" }; setConfig(next); persistConfig(next); }}>{item.displayName ?? id}{(id === config.model || (!config.model && item.isDefault)) && " ✓"}</button>;
            })}</div><strong>Уровень рассуждения</strong><div className="effort-options">{["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => <button type="button" key={effort} aria-pressed={effectiveEffort === effort} disabled={!supportedEfforts.some((item) => item.reasoningEffort === effort)} onClick={() => { const next = { ...config, effort }; setConfig(next); persistConfig(next); }}>{effortLabels[effort]}</button>)}</div></div>}
          </div>}
          {lane.provider === "openrouter" && <div className="model-widget"><button className="model-widget-trigger" type="button" aria-label={`Модель: ${config.model}`} aria-expanded={modelOpen} onClick={() => setModelOpen(!modelOpen)}>{config.model || "Модель"}</button>{modelOpen && <div className="model-popover"><label>Модель OpenRouter<input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} onBlur={() => persistConfig()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); persistConfig(); setModelOpen(false); } }} /></label><button type="button" onClick={() => { persistConfig(); setModelOpen(false); }}>Применить</button></div>}</div>}
          <div className="approval-widget"><button className="approval-chip" type="button" aria-label={`Подтверждение: ${lane.mcpAutoApprove ? "Автоподтверждение" : "Требует подтверждения"}`} aria-expanded={approvalOpen} onClick={() => setApprovalOpen(!approvalOpen)}>{lane.mcpAutoApprove ? "Автоподтверждение" : "Требует подтверждения"}</button>{approvalOpen && <div className="approval-popover" role="menu" aria-label="Подтверждение"><button type="button" role="menuitemradio" aria-checked={!lane.mcpAutoApprove} onClick={() => { onAutoApprove(false); setApprovalOpen(false); }}>Требует подтверждения</button><button type="button" role="menuitemradio" aria-checked={lane.mcpAutoApprove} onClick={() => { onAutoApprove(true); setApprovalOpen(false); }}>Автоподтверждение</button></div>}</div>
          <span className="context-meter" role="img" aria-label={`Контекст заполнен примерно на ${Math.min(100, Math.round(contextPlan.inputTokensEstimate / Math.max(1, contextPlan.budgetTokens) * 100))}%`} style={{ "--context": `${Math.min(100, contextPlan.inputTokensEstimate / Math.max(1, contextPlan.budgetTokens) * 100)}%` } as CSSProperties} />
          {(running || (contextPlan.overflow && !forceSend)) && <span>{running ? "Запрос выполняется" : "Подтверди отправку выше оценки бюджета"}</span>}
          {running && runId && <button type="button" className="cancel-run" onClick={() => onCancelRun(runId)}>Отменить</button>}
          <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Настройки сессии" title="Настройки сессии"><Icon name="settings" size={18} /></button>
          <button className="button primary" type="submit" disabled={!providerReady || running || !message.trim() || (contextPlan.overflow && !forceSend)} aria-label="Отправить сообщение">
            <Icon name="send" size={18} />
          </button>
        </div>
      </form></>}
      <div className="lane-resize" onPointerDown={startResize} role="separator" aria-label="Изменить ширину ленты" />
    </article>
  );
}
