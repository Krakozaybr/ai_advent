#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const endpoint = process.env.AI_ADVENT_V3_SUBAGENT_ENDPOINT;
const token = process.env.AI_ADVENT_V3_SUBAGENT_TOKEN;
if (!endpoint || !token) throw new Error("Subagent bridge configuration is missing.");

const server = new McpServer({ name: "ai-advent-subagents", version: "1.0.0" });

server.registerTool(
  "spawn_subagent",
  {
    title: "Запустить сабагента",
    description:
      "Создаёт дочернюю сессию для независимой параллельной задачи и сразу возвращает её идентификатор. Сабагент получает только задачу и инструкции доски. Доступны до 8 сабагентов на один ответ, одновременно работают не более 4. Вложенные сабагенты запрещены.",
    inputSchema: {
      task: z.string().trim().min(1).max(6_000).describe("Самостоятельная задача для дочерней сессии."),
      title: z.string().trim().max(120).optional().describe("Короткое название дочерней сессии."),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ task, title }, extra) => {
    const threadId = extra._meta?.threadId;
    if (typeof threadId !== "string" || !threadId) {
      return { isError: true, content: [{ type: "text", text: "Codex не передал доверенный threadId." }] };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId, task, title: title ?? "" }),
      signal: extra.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      return { isError: true, content: [{ type: "text", text: message }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
);

await server.connect(new StdioServerTransport());
