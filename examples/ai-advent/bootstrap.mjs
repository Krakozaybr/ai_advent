import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const statePath = join(root, ".bootstrap-state.json");
const baseUrl = (process.env.BOARD_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const DEMO = "Демонстрационное начальное состояние AI Advent; его можно изменить в интерфейсе.";
const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"));
state.boards ??= {};
state.lanes ??= {};
state.factLanes ??= {};

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path}: HTTP ${response.status}: ${value.error ?? "ошибка API"}`);
  return value;
}

const boardFiles = Array.from({ length: 9 }, (_, index) => `board-${String(index + 10).padStart(2, "0")}.json`);
const imported = new Map();
for (const file of boardFiles) {
  const payload = await readFile(join(root, "boards", file), "utf8");
  const result = await request("/api/boards/import", { method: "POST", body: payload });
  imported.set(Number(file.match(/\d+/)[0]), result.board);
}
const plan = [
  { day: 10, tools: { "Факты · общий checkpoint": [["sticky-facts", "read_facts"], ["sticky-facts", "update_fact"]], "Ветка · проверка альтернативы": [["sticky-facts", "read_facts"], ["sticky-facts", "update_fact"]] } },
  { day: 11, tools: { "Короткая память · transcript": [["lane-history", "history_search"], ["lane-history", "history_get"]], "Working + longTerm · approval": [["board-memory", "memory_list"], ["board-memory", "memory_read"], ["board-memory", "memory_propose_write"]] } },
  { day: 13, tools: { "Предложение MCP · с подтверждением": [["board-tasks", "tasks_list"], ["board-tasks", "tasks_read"], ["board-tasks", "tasks_propose_update"]] } },
  { day: 15, tools: { "Предложение MCP · approval": [["board-tasks", "tasks_list"], ["board-tasks", "tasks_read"], ["board-tasks", "tasks_propose_update"]] } },
  { day: 16, tools: { "Каталог локального MCP": [["ai-advent-demo", "lookup_demo_event"], ["local-catalog", "search_catalog"]] } },
  { day: 17, tools: { "Вызов read-only инструмента": [["ai-advent-demo", "lookup_demo_event"]] } },
];

function findLane(board, title) {
  const lane = board.lanes.find((item) => item.title === title);
  if (!lane) throw new Error(`День ${board.board.title}: нет ленты «${title}».`);
  return lane;
}

async function seedMcpSelections() {
  for (const item of plan) {
    const board = imported.get(item.day);
    for (const [title, selection] of Object.entries(item.tools)) {
      const lane = findLane(board, title);
      if (state.lanes[item.day]?.[title] === lane.id) continue;
      if ((lane.mcpTools ?? []).length > 0) continue;
      await request(`/api/lanes/${encodeURIComponent(lane.id)}/mcp-tools`, {
        method: "PATCH",
        body: JSON.stringify({ tools: selection.map(([serverId, toolName]) => ({ serverId, toolName })) }),
      });
      state.lanes[item.day] ??= {};
      state.lanes[item.day][title] = lane.id;
    }
  }
}

async function seedStickyFacts() {
  const board = imported.get(10);
  const key = "место-сбора";
  for (const title of ["Факты · общий checkpoint", "Ветка · проверка альтернативы"]) {
    const lane = findLane(board, title);
    if (state.factLanes[title] === lane.id) continue;
    if ((lane.stickyFacts ?? []).some((fact) => fact.key === key)) continue;
    await request(`/api/lanes/${encodeURIComponent(lane.id)}/facts`, {
      method: "PATCH", body: JSON.stringify({ key, value: `Библиотека; сбор до пятницы. ${DEMO}` }),
    });
    state.factLanes[title] = lane.id;
  }
}

async function seedMemory() {
  const board = imported.get(11).board;
  if (state.boards[11] === board.id) return;
  const path = `/api/boards/${encodeURIComponent(board.id)}/memories`;
  let memoryState = await request(path);
  const memoryName = "обмен-книгами";
  if (!(memoryState.workingMemories ?? []).some((item) => item.name === memoryName)) {
    memoryState = await request(`${path}/working`, { method: "POST", body: JSON.stringify({ name: memoryName }) });
  }
  const existing = new Map((memoryState.workingMemories ?? []).find((item) => item.name === memoryName)?.items?.map((item) => [item.key, item.value]) ?? []);
  const items = [
    ["цель", "Собрать 30 книг за неделю."],
    ["ограничение", "Волонтёров двое; хранить книги можно не дольше недели."],
  ];
  for (const [key, value] of items) {
    if (existing.has(key)) continue;
    await request(`${path}/working/${encodeURIComponent(memoryName)}/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ value: `${value} ${DEMO}` }) });
  }
  const longTerm = new Map((memoryState.longTerm ?? []).map((item) => [item.key, item.value]));
  if (!longTerm.has("предпочтение-клуба")) {
    await request(`${path}/longTerm/_/${encodeURIComponent("предпочтение-клуба")}`, { method: "PATCH", body: JSON.stringify({ value: `Для книжного клуба план присылать за день до встречи. ${DEMO}` }) });
  }
  state.boards[11] = board.id;
}

async function seedTasks(day) {
  const board = imported.get(day).board;
  if (state.boards[day] === board.id) return;
  const path = `/api/boards/${encodeURIComponent(board.id)}/tasks`;
  const taskState = await request(path);
  const title = day === 13 ? "Подготовить районный обмен книгами" : "Утвердить план книжного обмена";
  if ((taskState.tasks ?? []).some((task) => task.title === title)) return;
  const description = day === 13
    ? `Демонстрационная задача. Провести обмен для 20 семей; состояние предлагается менять через MCP и проверять в UI. ${DEMO}`
    : `Демонстрационная задача для показа этапов планирования и подтверждения. ${DEMO}`;
  const task = await request(path, { method: "POST", body: JSON.stringify({ title, description }) });
  await request(`${path}/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      plan: "1. Подтвердить место. 2. Отсортировать книги по жанрам. 3. Проверить повреждения и срок хранения.",
      currentStep: "Подготовить черновик плана",
      expectedAction: "Пользователь проверяет и при необходимости утверждает план",
    }),
  });
  state.boards[day] = board.id;
}

await seedMcpSelections();
await seedStickyFacts();
await seedMemory();
await seedTasks(13);
await seedTasks(15);

for (const day of [10, 11, 13, 15]) {
  state.boards[day] ??= imported.get(day).board.id;
}
for (const item of plan) {
  const board = imported.get(item.day);
  for (const title of Object.keys(item.tools)) {
    const lane = findLane(board, title);
    state.lanes[item.day] ??= {};
    state.lanes[item.day][title] ??= lane.id;
  }
}
for (const title of ["Факты · общий checkpoint", "Ветка · проверка альтернативы"]) {
  const lane = findLane(imported.get(10), title);
  state.factLanes[title] ??= lane.id;
}

// Re-read ordinary APIs so setup reports the state users will see in v3.
for (const item of plan) {
  const boardId = imported.get(item.day).board.id;
  await request(`/api/boards/${encodeURIComponent(boardId)}`);
}
await request(`/api/boards/${encodeURIComponent(imported.get(11).board.id)}/memories`);
await request(`/api/boards/${encodeURIComponent(imported.get(13).board.id)}/tasks`);
await request(`/api/boards/${encodeURIComponent(imported.get(15).board.id)}/tasks`);
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
console.log(`Bootstrap завершён через ${baseUrl}: выборы MCP, Sticky Facts, working/longTerm memory и стартовые задачи сверены через API.`);
