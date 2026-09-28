#!/usr/bin/env node
import { createInterface } from "node:readline";

const events = [
  { id: "book-swap", title: "Демонстрационный обмен книгами", date: "2026-10-03", venue: "Библиотека", description: "Локальный учебный обмен книгами." },
  { id: "mcp-workshop", title: "Демонстрационный семинар MCP", date: "2026-10-05", venue: "Учебный класс", description: "Практика работы с инструментами MCP." },
  { id: "autumn-meetup", title: "Демонстрационная встреча", date: "2026-10-09", venue: "Клуб", description: "Локальная учебная встреча." },
];
const eventSchema = {
  type: "object",
  properties: Object.fromEntries(["id", "title", "date", "venue", "description"].map((key) => [key, { type: "string", maxLength: 300 }])),
  required: ["id", "title", "date", "venue", "description"],
  additionalProperties: false,
};
const tools = [
  {
    name: "search_events",
    description: "Ищет события в неизменяемом локальном учебном наборе.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "summarize_events",
    description: "Составляет детерминированную сводку из переданного массива событий.",
    inputSchema: { type: "object", properties: { events: { type: "array", minItems: 1, maxItems: 20, items: eventSchema } }, required: ["events"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const validEvent = (event) => event && typeof event === "object" && !Array.isArray(event) &&
  Object.keys(event).sort().join() === Object.keys(eventSchema.properties).sort().join() &&
  Object.keys(eventSchema.properties).every((key) => typeof event[key] === "string" && event[key].length <= 300);

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.method === "notifications/initialized") continue;
  const base = { jsonrpc: "2.0", id: request.id };
  if (request.method === "initialize") {
    write({ ...base, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "demo-events", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    write({ ...base, result: { tools } });
  } else if (request.method === "tools/call") {
    const { name, arguments: args } = request.params ?? {};
    let value;
    if (name === "search_events") {
      if (!args || Object.keys(args).join() !== "query" || typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) {
        value = failure("Invalid query.");
      } else {
        const words = args.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const matches = events.filter((event) => words.every((word) => Object.values(event).join(" ").toLocaleLowerCase().includes(word)));
        value = result({ events: matches });
      }
    } else if (name === "summarize_events") {
      const input = args?.events;
      if (!args || Object.keys(args).join() !== "events" || !Array.isArray(input) || input.length < 1 || input.length > 20 || !input.every(validEvent)) {
        value = failure("Invalid events array.");
      } else {
        value = result({ eventCount: input.length, titles: input.map((event) => event.title), summary: input.map((event) => `${event.date}: ${event.title} — ${event.venue}`).join("\n") });
      }
    } else {
      write({ ...base, error: { code: -32601, message: "Unknown tool." } });
      continue;
    }
    write({ ...base, result: value });
  } else if (request.id !== undefined) {
    write({ ...base, error: { code: -32601, message: "Method not found." } });
  }
}
