#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function openScope(readOnly = false) {
  const boardPath = process.env.AI_ADVENT_V3_BOARD_DB;
  const laneId = process.env.AI_ADVENT_V3_LANE_ID;
  const memoryPath = process.env.AI_ADVENT_V3_MEMORY_DB;
  if (!boardPath || !laneId || !memoryPath) throw new Error("Trusted board, lane and memory scope is required.");
  const board = new DatabaseSync(boardPath, { readOnly: true, timeout: 5000 });
  const lane = board.prepare("SELECT board_id FROM lanes WHERE id=?").get(laneId);
  board.close();
  if (!lane) throw new Error("Trusted lane no longer exists.");
  const db = new DatabaseSync(memoryPath, { readOnly, timeout: 5000 });
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, boardId: lane.board_id };
}

const server = new McpServer({ name: "ai-advent-board-memory", version: "1.0.0" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const layer = z.enum(["working", "longTerm"]).describe("Слой: рабочая память или общая долговременная память доски");

server.registerTool("memory_list", {
  title: "Список памяти доски",
  description: "Показывает имена рабочих памятей текущей доски и ключи долговременной памяти.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { db, boardId } = openScope(true);
  try {
    const workingMemories = db.prepare("SELECT name FROM working_memories WHERE board_id=? ORDER BY name").all(boardId).map(({ name }) => name);
    const longTermKeys = db.prepare("SELECT memory_key AS key FROM memory_items WHERE board_id=? AND layer='longTerm' AND memory_name='' ORDER BY memory_key").all(boardId).map(({ key }) => key);
    return result({ workingMemories, longTermKeys });
  } finally { db.close(); }
});

server.registerTool("memory_read", {
  title: "Прочитать память доски",
  description: "Читает записи из одной реально существующей рабочей памяти или из общей долговременной памяти доски.",
  inputSchema: {
    layer,
    memoryName: z.string().trim().min(1).max(80).optional().describe("Точное имя рабочей памяти; не указывай для longTerm"),
    query: z.string().trim().max(300).optional().describe("Необязательный фильтр по ключу или значению"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ layer: targetLayer, memoryName, query }) => {
  const { db, boardId } = openScope(true);
  try {
    const targetName = targetLayer === "working" ? memoryName : "";
    if (targetLayer === "longTerm" && memoryName) throw new Error("У долговременной памяти нет имени рабочей памяти.");
    if (targetLayer === "working" && !db.prepare("SELECT 1 FROM working_memories WHERE board_id=? AND name=?").get(boardId, targetName)) {
      throw new Error("Рабочая память с таким именем не создана на этой доске.");
    }
    const items = db.prepare("SELECT memory_key AS key,value,updated_at AS updatedAt FROM memory_items WHERE board_id=? AND layer=? AND memory_name=? AND (?='' OR instr(lower(memory_key || ' ' || value),lower(?)) > 0) ORDER BY memory_key")
      .all(boardId, targetLayer, targetName, query ?? "", query ?? "");
    return result({ layer: targetLayer, memoryName: targetLayer === "working" ? targetName : "Долговременная", items });
  } finally { db.close(); }
});

server.registerTool("memory_propose_write", {
  title: "Предложить запись в память",
  description: "Предлагает создать или обновить одну запись. Сервер приложения отправит её на подтверждение; удалять данные этим инструментом нельзя.",
  inputSchema: {
    layer,
    memoryName: z.string().trim().min(1).max(80).optional().describe("Точное имя существующей рабочей памяти; для longTerm не указывай"),
    key: z.string().trim().min(1).max(100).describe("Ключ записи"),
    value: z.string().trim().min(1).max(4000).describe("Предлагаемое значение"),
    reason: z.string().trim().min(1).max(300).describe("Зачем нужна запись"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ layer: targetLayer, memoryName, key, value, reason }) => {
  const { db, boardId } = openScope();
  try {
    if (targetLayer === "working" && !db.prepare("SELECT 1 FROM working_memories WHERE board_id=? AND name=?").get(boardId, memoryName)) {
      throw new Error("Рабочая память с таким именем не создана на этой доске.");
    }
    if (targetLayer === "longTerm" && memoryName) throw new Error("У долговременной памяти нет имени рабочей памяти.");
    db.prepare("INSERT INTO memory_items(board_id,layer,memory_name,memory_key,value,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(board_id,layer,memory_name,memory_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(boardId, targetLayer, targetLayer === "working" ? memoryName : "", key, value, new Date().toISOString());
    return result({ status: "saved", target: { layer: targetLayer, memoryName: targetLayer === "working" ? memoryName : "Долговременная", key }, value, reason });
  } finally { db.close(); }
});

await server.connect(new StdioServerTransport());
