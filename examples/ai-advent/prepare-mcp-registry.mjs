import { open, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(root, "v3/data/mcp-servers.json");
const registry = {
  servers: [
    {
      id: "local-catalog",
      name: "Локальный каталог",
      description: "Поиск в локальных заметках о MCP.",
      command: "node",
      args: ["${PROJECT_ROOT}/examples/mcp/catalog-server.mjs"],
      cwd: "${PROJECT_ROOT}",
    },
    {
      id: "ai-advent-demo",
      name: "AI Advent · mock API",
      description: "Статический локальный каталог демонстрационных событий; без сети и изменений данных.",
      command: "node",
      args: ["${PROJECT_ROOT}/examples/mcp/mock-event-server.mjs"],
      cwd: "${PROJECT_ROOT}",
    },
  ],
};

await mkdir(dirname(target), { recursive: true });
let handle;
try {
  handle = await open(target, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Создан ${target}`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`Существующий реестр сохранён без изменений: ${target}`);
} finally {
  await handle?.close();
}
