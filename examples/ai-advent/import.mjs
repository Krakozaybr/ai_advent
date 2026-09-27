import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const boardsDir = join(root, "boards");
const baseUrl = (process.env.BOARD_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const requestedFile = process.argv[2];
if (requestedFile === "--help" || requestedFile === "-h") {
  console.log("Usage: node examples/ai-advent/import.mjs [board-NN.json]\nBOARD_API_URL defaults to http://127.0.0.1:3001");
  process.exit(0);
}
const files = requestedFile ? [requestedFile] : (await readdir(boardsDir)).filter((name) => /^board-\d+\.json$/.test(name)).sort();

for (const file of files) {
  const payload = await readFile(join(boardsDir, file), "utf8");
  const response = await fetch(`${baseUrl}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}: ${result.error ?? "import failed"}`);
  console.log(`${file}: ${result.reused ? "уже импортирована" : "создана"} · ${baseUrl}${result.url}`);
}
