import express from "express";
import { resolve } from "node:path";
import { createApp } from "./app.mjs";

const port = Number(process.env.PORT || 3000);
const development = process.env.NODE_ENV === "development";
const app = createApp();

if (development) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    appType: "spa",
    server: { middlewareMode: true },
  });
  app.use(vite.middlewares);
} else {
  const clientDirectory = resolve("dist");
  app.use(express.static(clientDirectory));
  app.use((_request, response) => {
    response.sendFile(resolve(clientDirectory, "index.html"));
  });
}

app.listen(port, "127.0.0.1", () => {
  console.log(`AI Advent: http://127.0.0.1:${port}`);
});
