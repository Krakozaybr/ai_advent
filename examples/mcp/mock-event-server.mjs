#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

// Static offline fixture. It does not contact a real service or mutate data.
const events = {
  "spring-book-swap": {
    id: "spring-book-swap",
    title: "Демонстрационный обмен книгами",
    venue: "Читальный зал библиотеки",
    date: "2026-10-03",
    note: "Статическая запись для показа; это не реальное событие.",
  },
};

const server = new McpServer({ name: "ai-advent-demo", version: "1.0.0" });
server.registerTool("lookup_demo_event", {
  title: "Найти демонстрационное событие",
  description: "Возвращает статическую локальную запись события по ID; не обращается к сети и ничего не меняет.",
  inputSchema: { eventId: z.string().trim().min(1).max(80).describe("ID демонстрационного события") },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ eventId }) => {
  const event = events[eventId];
  const value = event ? { found: true, event } : { found: false, eventId };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
});

await server.connect(new StdioServerTransport());
