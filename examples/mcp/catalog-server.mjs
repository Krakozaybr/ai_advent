#!/usr/bin/env node
// Read-only example MCP server. It uses newline-delimited JSON-RPC on stdio.
const catalog = [
  { id: "mcp-basics", title: "MCP basics", summary: "A local, offline note about the Model Context Protocol." },
  { id: "tool-safety", title: "Tool safety", summary: "Tools should be explicitly registered and arguments validated." },
  { id: "openrouter-tools", title: "OpenRouter tools", summary: "The application executes tool calls and returns results to the model." },
];
import { createInterface } from "node:readline";

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.method === "notifications/initialized") continue;
  if (request.method === "initialize") {
    write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "local-catalog", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    write({ jsonrpc: "2.0", id: request.id, result: { tools: [{
      name: "search_catalog",
      description: "Найти локальную заметку по словам в названии, описании или тексте.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Слова для поиска" } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }] } });
  } else if (request.method === "tools/call" && request.params?.name === "search_catalog") {
    const query = String(request.params.arguments?.query ?? "").trim().toLowerCase();
    const matches = catalog.filter((item) => `${item.title} ${item.summary} ${item.id}`.toLowerCase().includes(query));
    write({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: JSON.stringify(matches) }],
      structuredContent: { query, count: matches.length, items: matches },
    } });
  } else if (request.id !== undefined) {
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}
