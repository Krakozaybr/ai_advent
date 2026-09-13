import express from "express";

export function createApp() {
  const app = express();

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  return app;
}
