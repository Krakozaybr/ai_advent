#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function openScope() {
  const databasePath = process.env.AI_ADVENT_V3_BOARD_DB;
  const laneId = process.env.AI_ADVENT_V3_LANE_ID;
  if (!databasePath || !laneId) throw new Error("Trusted board and lane scope is required.");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, laneId };
}

const server = new McpServer({ name: "ai-advent-lane-history", version: "1.0.0" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

server.registerTool("history_search", {
  title: "Поиск в истории этой ленты",
  description: "Ищет в сохранённых сообщениях текущей ленты, включая сообщения за пределами выбранного окна контекста.",
  inputSchema: {
    query: z.string().trim().min(1).max(300).describe("Текст для поиска в истории"),
    limit: z.number().int().min(1).max(20).optional().describe("Число результатов, максимум 20"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ query, limit = 10 }) => {
  const { db, laneId } = openScope();
  try {
    const messages = db.prepare("SELECT id, role, content, created_at AS createdAt FROM messages WHERE lane_id=? AND instr(lower(content), lower(?)) > 0 ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(laneId, query, limit);
    return result({ laneHistory: true, count: messages.length, messages });
  } finally { db.close(); }
});

server.registerTool("history_get", {
  title: "Прочитать сообщение из истории этой ленты",
  description: "Получает одно сохранённое сообщение по ID только из текущей ленты.",
  inputSchema: { messageId: z.string().min(1).max(80) },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ messageId }) => {
  const { db, laneId } = openScope();
  try {
    const message = db.prepare("SELECT id, role, content, created_at AS createdAt FROM messages WHERE lane_id=? AND id=?").get(laneId, messageId);
    return result({ laneHistory: true, message: message ?? null });
  } finally { db.close(); }
});

await server.connect(new StdioServerTransport());
