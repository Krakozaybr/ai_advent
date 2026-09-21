#!/usr/bin/env node

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { DAY11_MEMORY_LAYERS, DAY11_SCOPE_ID } from "../shared/day11.js";
import { createMemoryStore } from "./memory-store.mjs";

const databasePath = process.env.AI_ADVENT_DB_PATH || resolve("data/agent.sqlite");
const scopeId = process.env.AI_ADVENT_MEMORY_SCOPE_ID || DAY11_SCOPE_ID;
const store = createMemoryStore(databasePath);
const layerSchema = z.enum(Object.keys(DAY11_MEMORY_LAYERS));

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const server = new McpServer({ name: "ai-advent-memory", version: "1.0.0" });

server.registerTool(
  "memory_list",
  {
    title: "Прочитать память",
    description: "Возвращает записи из трёх слоёв памяти агента.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => toolResult({ ok: true, layers: store.getState(scopeId).layers }),
);

server.registerTool(
  "memory_save",
  {
    title: "Сохранить запись в память",
    description:
      "Сохраняет явно сформулированный факт в выбранный слой памяти. shortTerm — временный контекст, working — текущая задача, longTerm — устойчивые предпочтения пользователя.",
    inputSchema: {
      layer: layerSchema.describe("Слой памяти: shortTerm, working или longTerm"),
      key: z.string().trim().min(1).max(80).describe("Короткий стабильный ключ на английском"),
      value: z.string().trim().min(1).max(2_000).describe("Факт, который нужно сохранить"),
      reason: z.string().trim().min(1).max(300).describe("Почему факт относится к выбранному слою"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ layer, key, value, reason }) => {
    store.upsertItem(scopeId, layer, key, value);
    return toolResult({ ok: true, action: "saved", layer, key, value, reason });
  },
);

server.registerTool(
  "memory_delete",
  {
    title: "Удалить запись из памяти",
    description: "Удаляет одну запись по слою и ключу.",
    inputSchema: {
      layer: layerSchema,
      key: z.string().trim().min(1).max(80),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ layer, key }) => {
    store.deleteItem(scopeId, layer, key);
    return toolResult({ ok: true, action: "deleted", layer, key });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
