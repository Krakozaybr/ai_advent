#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

function scope() {
  const databasePath = process.env.AI_ADVENT_V3_BOARD_DB;
  const laneId = process.env.AI_ADVENT_V3_LANE_ID;
  if (!databasePath || !laneId) throw new Error("Trusted board and lane scope is required.");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000");
  return { db, laneId };
}

const server = new McpServer({ name: "sticky-facts", version: "1.0.0" });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

server.registerTool("read_facts", {
  title: "Прочитать постоянные факты",
  description: "Читает key/value факты, сохранённые для текущей ленты.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const { db, laneId } = scope();
  const facts = db.prepare("SELECT fact_key AS key, fact_value AS value FROM sticky_facts WHERE lane_id=? ORDER BY fact_key").all(laneId);
  db.close();
  return result({ ok: true, facts });
});

server.registerTool("update_fact", {
  title: "Предложить изменение факта",
  description: "Предлагает создать или обновить факт. Изменение ожидает подтверждения пользователя.",
  inputSchema: {
    key: z.string().trim().min(1).max(80).describe("Короткий ключ факта"),
    value: z.string().trim().min(1).max(2000).describe("Значение факта"),
    reason: z.string().trim().min(1).max(300).describe("Зачем этот факт нужен"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ key, value, reason }) => {
  const { db, laneId } = scope();
  db.prepare("INSERT INTO sticky_facts(lane_id,fact_key,fact_value,updated_at) VALUES(?,?,?,?) ON CONFLICT(lane_id,fact_key) DO UPDATE SET fact_value=excluded.fact_value,updated_at=excluded.updated_at")
    .run(laneId, key, value, new Date().toISOString());
  db.close();
  return result({ action: "saved", key, value, reason });
});

const transport = new StdioServerTransport();
await server.connect(transport);
