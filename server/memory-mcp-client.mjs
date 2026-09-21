import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_DATABASE_PATH = resolve("data/agent.sqlite");
const SERVER_PATH = fileURLToPath(new URL("./memory-mcp-server.mjs", import.meta.url));

function readTextContent(content = []) {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export class MemoryMcpClient {
  constructor({ databasePath = DEFAULT_DATABASE_PATH, serverPath = SERVER_PATH } = {}) {
    this.databasePath = databasePath;
    this.serverPath = serverPath;
    this.client = null;
    this.tools = null;
  }

  async connect() {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", this.serverPath],
      env: {
        AI_ADVENT_DB_PATH: this.databasePath,
        AI_ADVENT_MEMORY_SCOPE_ID: "day11-default",
      },
      stderr: "inherit",
    });
    const client = new Client({ name: "ai-advent-web", version: "1.0.0" });
    await client.connect(transport);
    this.client = client;
  }

  async listTools() {
    await this.connect();
    if (!this.tools) {
      this.tools = (await this.client.listTools()).tools;
    }
    return this.tools;
  }

  async getOpenRouterTools(names = ["memory_save"]) {
    const allowed = new Set(names);
    return (await this.listTools())
      .filter((tool) => allowed.has(tool.name))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
  }

  async callTool(name, argumentsValue) {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: argumentsValue });
    const text = readTextContent(result.content);
    let structuredContent = result.structuredContent;
    if (!structuredContent && text) {
      try {
        structuredContent = JSON.parse(text);
      } catch {
        structuredContent = { text };
      }
    }
    return {
      isError: Boolean(result.isError),
      text,
      structuredContent: structuredContent ?? null,
    };
  }

  async close() {
    if (!this.client) return;
    await this.client.close();
    this.client = null;
    this.tools = null;
  }
}

export function createMemoryMcpClient(options) {
  return new MemoryMcpClient(options);
}
