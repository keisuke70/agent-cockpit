import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { getDb, closeDb } from "./db.js";
import { repoRoutes } from "./routes/repos.js";
import { sessionRoutes } from "./routes/sessions.js";
import { wsRoutes } from "./ws/handler.js";
import { cleanupAll } from "./process-manager.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// Simple token-based auth for single-user deployment
const DATA_DIR = join(homedir(), "Library", "Application Support", "agent-cockpit");
const TOKEN_FILE = join(DATA_DIR, "auth-token");

function getOrCreateToken(): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

export const AUTH_TOKEN = getOrCreateToken();

async function main() {
  const app = Fastify({ logger: true });

  // CORS: only allow localhost and tailscale origins
  await app.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.match(/^https?:\/\/100\.\d+\.\d+\.\d+/)
      ) {
        cb(null, true);
      } else {
        cb(new Error("CORS not allowed"), false);
      }
    },
  });

  await app.register(websocket);

  // Auth hook for all /api and /ws routes
  app.addHook("onRequest", (req, reply, done) => {
    if (req.url === "/api/health") return done();

    const token =
      req.headers.authorization?.replace("Bearer ", "") ??
      new URL(req.url, `http://${req.headers.host}`).searchParams.get("token");

    if (token !== AUTH_TOKEN) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    done();
  });

  // Initialize DB
  getDb();

  // Routes
  await app.register(repoRoutes);
  await app.register(sessionRoutes);
  await app.register(wsRoutes);

  // Health check
  app.get("/api/health", () => ({ ok: true }));

  // Graceful shutdown
  const shutdown = () => {
    cleanupAll();
    closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: PORT, host: HOST });
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN}`);
  console.log(`Token file: ${TOKEN_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
