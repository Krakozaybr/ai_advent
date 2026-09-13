import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function createSettingsStore(filePath = resolve("data/settings.json")) {
  async function readSettings() {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  return {
    async getApiKey() {
      const settings = await readSettings();
      return typeof settings.openRouterApiKey === "string" ? settings.openRouterApiKey.trim() : "";
    },

    async saveApiKey(apiKey) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify({ openRouterApiKey: apiKey }, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(filePath, 0o600);
    },
  };
}
