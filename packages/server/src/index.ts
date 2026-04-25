import { randomBytes } from "node:crypto";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  createWriteStream,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { getDb, closeDb } from "./db.js";
import { repoRoutes } from "./routes/repos.js";
import { sessionRoutes } from "./routes/sessions.js";
import { pushRoutes } from "./routes/push.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { wsRoutes } from "./ws/handler.js";
import { lobbyRoutes } from "./ws/lobby-handler.js";
import { cleanupAll } from "./process-manager.js";
import { initPush } from "./push.js";
import { initScheduler, stopAllSchedules } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// Simple token-based auth for single-user deployment
const DATA_DIR = join(homedir(), "Library", "Application Support", "agent-cockpit");
const TOKEN_FILE = join(DATA_DIR, "auth-token");
const LOG_DIR = join(homedir(), "Library", "Logs", "agent-cockpit");
const LOG_FILE = join(LOG_DIR, "server.log");

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function getOrCreateToken(): { token: string; created: boolean } {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    return { token: readFileSync(TOKEN_FILE, "utf8").trim(), created: false };
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return { token, created: true };
}

const { token: AUTH_TOKEN, created: TOKEN_FRESHLY_CREATED } = getOrCreateToken();
export { AUTH_TOKEN };

async function main() {
  ensureLogDir();
  const logStream = createWriteStream(LOG_FILE, { flags: "a" });
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      stream: logStream,
    },
  });

  // CORS: allow localhost, tailscale IPs, and *.ts.net (Tailscale Serve HTTPS)
  await app.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.match(/^https?:\/\/100\.\d+\.\d+\.\d+/) ||
        origin.match(/^https:\/\/[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net$/)
      ) {
        cb(null, true);
      } else {
        cb(new Error("CORS not allowed"), false);
      }
    },
  });

  await app.register(websocket);

  // Auth hook: only protect /api and /ws routes. Static assets (the SPA
  // shell) must load unauthenticated so the login screen can render.
  app.addHook("onRequest", (req, reply, done) => {
    const url = req.url;
    if (url === "/api/health") return done();
    if (!url.startsWith("/api") && !url.startsWith("/ws")) return done();

    const token =
      req.headers.authorization?.replace("Bearer ", "") ??
      new URL(url, `http://${req.headers.host}`).searchParams.get("token");

    if (token !== AUTH_TOKEN) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    done();
  });

  // Initialize DB
  getDb();

  // Initialize Web Push (loads or generates VAPID keys)
  initPush();

  // Initialize cron scheduler (loads enabled schedules from DB)
  initScheduler();

  // Routes
  await app.register(repoRoutes);
  await app.register(sessionRoutes);
  await app.register(pushRoutes);
  await app.register(scheduleRoutes);
  await app.register(wsRoutes);
  await app.register(lobbyRoutes);

  // Health check
  app.get("/api/health", () => ({ ok: true }));

  // Static frontend (built web assets). When the dist directory exists,
  // serve it from the same port so Tailscale Serve can expose a single origin.
  const webDist = resolve(__dirname, "..", "..", "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback: any non-API GET serves index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      reply.status(404).send({ error: "Not found" });
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    stopAllSchedules();
    cleanupAll();
    closeDb();
    logStream.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Server listening on http://${HOST}:${PORT}`);
  app.log.info(`Auth token: ${AUTH_TOKEN}`);
  app.log.info(`Token file: ${TOKEN_FILE}`);
  app.log.info(`Log file:   ${LOG_FILE}`);
  // Mirror the auth token to stdout only on first run, to avoid leaking it
  // into terminal scrollback on every restart.
  if (TOKEN_FRESHLY_CREATED) {
    process.stdout.write(
      `\nAgent Cockpit ready: http://${HOST}:${PORT}\nAuth token (first run only): ${AUTH_TOKEN}\nStored at: ${TOKEN_FILE}\n\n`,
    );
  } else {
    process.stdout.write(
      `\nAgent Cockpit ready: http://${HOST}:${PORT}\nAuth token: see ${TOKEN_FILE}\n\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
