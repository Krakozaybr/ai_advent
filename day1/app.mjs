import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const prompt = process.argv.slice(2).join(" ") || "Привет! Ответь одной короткой фразой.";
const model = process.env.CODEX_MODEL || null;
const server = spawn("codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
let answer = "";
let finishTurn;

function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params) {
  server.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

const completed = new Promise((resolve, reject) => {
  finishTurn = { resolve, reject };
});

createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }

  if (message.method === "item/agentMessage/delta") {
    answer += message.params.delta;
  }

  if (message.method === "turn/completed") {
    const finalAnswer = message.params.turn.items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("");
    finishTurn.resolve(finalAnswer || answer);
  }
});

server.on("error", (error) => finishTurn.reject(error));
server.stderr.on("data", () => {});

try {
  await request("initialize", {
    clientInfo: { name: "ai-advent", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});

  const thread = await request("thread/start", {
    cwd: process.cwd(),
    ephemeral: true,
    environments: [],
    model,
    sandbox: "read-only",
    approvalPolicy: "never",
  });

  await request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: prompt }],
  });

  const timeout = setTimeout(() => {
    finishTurn.reject(new Error("Превышено время ожидания ответа Codex."));
  }, 120_000);
  const result = await completed;
  clearTimeout(timeout);

  console.log(result || "Codex не вернул текстовый ответ.");
} catch (error) {
  console.error(`Ошибка Codex app-server: ${error.message}`);
  process.exitCode = 1;
} finally {
  server.kill();
}
