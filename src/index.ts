import { Hono } from "hono";

import { loadConfig } from "./types";
import { handleGitHubWebhook } from "./webhook-handler";

const config = loadConfig(Bun.env);
const startedAt = Date.now();
const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  });
});

app.post("/webhook", async (c) => {
  return handleGitHubWebhook(c, config);
});

app.onError((error, c) => {
  console.error(`[server] error=${error.message}`);
  return c.json({ ok: false, error: "Internal server error" }, 500);
});

const server = Bun.serve({
  port: config.port,
  fetch: app.fetch,
});

console.info(`[server] listening on http://localhost:${server.port}`);

const shutdown = async (signal: string): Promise<void> => {
  console.info(`[server] received ${signal}, shutting down`);
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
