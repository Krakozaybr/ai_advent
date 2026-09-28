#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const outputDirectory = resolve(fileURLToPath(new URL("../../v3/data/demo-outputs/", import.meta.url)));
const summarySchema = {
  type: "object",
  properties: {
    eventCount: { type: "integer", minimum: 1, maximum: 20 },
    titles: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 300 } },
    summary: { type: "string", minLength: 1, maxLength: 10000 },
  },
  required: ["eventCount", "titles", "summary"],
  additionalProperties: false,
};
const tools = [{
  name: "save_summary",
  description: "Сохраняет переданную сводку только в локальном v3/data/demo-outputs с новым безопасным именем.",
  inputSchema: { type: "object", properties: { summary: summarySchema }, required: ["summary"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}];
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const validSummary = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === Object.keys(summarySchema.properties).sort().join() &&
  Number.isInteger(value.eventCount) && value.eventCount >= 1 && value.eventCount <= 20 &&
  Array.isArray(value.titles) && value.titles.length === value.eventCount &&
  value.titles.every((title) => typeof title === "string" && title.length <= 300) &&
  typeof value.summary === "string" && value.summary.length >= 1 && value.summary.length <= 10000;

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.method === "notifications/initialized") continue;
  const base = { jsonrpc: "2.0", id: request.id };
  if (request.method === "initialize") {
    write({ ...base, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "demo-notes", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    write({ ...base, result: { tools } });
  } else if (request.method === "tools/call" && request.params?.name === "save_summary") {
    const args = request.params.arguments;
    if (!args || Object.keys(args).join() !== "summary" || !validSummary(args.summary)) {
      write({ ...base, result: failure("Invalid summary.") });
      continue;
    }
    try {
      await mkdir(outputDirectory, { recursive: true });
      if (!(await lstat(outputDirectory)).isDirectory()) throw new Error("Output directory is not a directory.");
      const basename = `${randomUUID()}.json`;
      await writeFile(resolve(outputDirectory, basename), `${JSON.stringify(args.summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const value = { path: `v3/data/demo-outputs/${basename}` };
      write({ ...base, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
    } catch {
      write({ ...base, result: failure("Could not save demo summary.") });
    }
  } else if (request.id !== undefined) {
    write({ ...base, error: { code: -32601, message: "Method not found." } });
  }
}
