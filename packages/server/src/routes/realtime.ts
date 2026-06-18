import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getCodexAppServerClient,
  type AppServerMessage,
} from "../codex/app-server-client.js";
import { ensureManaged, isCodexThreadBusyForNewWork } from "../ws/session-bridge.js";
import { broadcastEvent, nextSeq, type ManagedSession } from "../process-manager.js";

interface RealtimeStartBody {
  sdp?: string;
  outputModality?: "text" | "audio";
}

const REALTIME_START_TIMEOUT_MS = 35_000;

export async function realtimeRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: RealtimeStartBody }>(
    "/api/sessions/:id/codex-realtime/start",
    async (req, reply) => {
      const { sdp, outputModality = "text" } = req.body ?? {};
      if (typeof sdp !== "string" || !sdp.trim()) {
        return reply.status(400).send({ error: "Missing WebRTC offer SDP" });
      }

      const managed = await ensureManaged(req.params.id);
      if (managed.runtime !== "codex-app-server" || !managed.codexThreadId) {
        return reply.status(400).send({ error: "Codex realtime requires a Codex session" });
      }

      if (isRealtimeBusy(managed) || isCodexThreadBusyForNewWork(managed, req.params.id)) {
        return reply.status(409).send({ error: "Codex thread is busy. Wait for the current text or voice operation to finish before starting voice." });
      }

      const startToken = randomUUID();
      const threadId = managed.codexThreadId;
      managed.codexRealtimeState = "starting";
      managed.codexRealtimeError = null;
      managed.codexRealtimeStartInFlight = true;
      managed.codexRealtimeStartToken = startToken;

      const client = await getCodexAppServerClient();
      const sdpFromNotification = waitForRealtimeSdp(client, threadId, startToken, managed);
      let result: any;
      try {
        result = await withTimeout(
          client.request("thread/realtime/start", {
            threadId,
            outputModality,
            transport: { type: "webrtc", sdp },
          }),
          REALTIME_START_TIMEOUT_MS,
          "Codex realtime start timed out",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to start Codex realtime";
        if (!isCurrentRealtimeStart(managed, startToken)) {
          await stopRealtimeBestEffort(client, threadId);
          return reply.status(409).send({ error: "Codex voice start was cancelled" });
        }
        await cleanupRealtimeStartFailure(client, managed, threadId, startToken, friendlyRealtimeStartError(message));
        return reply.status(isRealtimeUnsupportedError(message) ? 409 : 502).send({
          error: managed.codexRealtimeError,
        });
      }

      const answerSdp =
        result?.sdp ??
        result?.transport?.sdp ??
        result?.answer?.sdp ??
        result?.sessionDescription?.sdp ??
        (await sdpFromNotification);

      if (!isCurrentRealtimeStart(managed, startToken) || managed.codexRealtimeState !== "starting") {
        await stopRealtimeBestEffort(client, threadId);
        finishRealtimeStart(managed, startToken, "idle");
        return reply.status(409).send({ error: "Codex voice start was cancelled" });
      }

      if (typeof answerSdp !== "string" || !answerSdp.trim()) {
        await cleanupRealtimeStartFailure(
          client,
          managed,
          threadId,
          startToken,
          "Codex realtime answer SDP did not arrive. Please try Mic again; this voice attempt was isolated and text chat can continue.",
        );
        return reply.status(502).send({
          error: managed.codexRealtimeError,
          result,
        });
      }

      finishRealtimeStart(managed, startToken, "active");
      return { sdp: answerSdp };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/codex-realtime/stop",
    async (req, reply) => {
      const managed = await ensureManaged(req.params.id);
      if (managed.runtime !== "codex-app-server" || !managed.codexThreadId) {
        return reply.status(400).send({ error: "Codex realtime requires a Codex session" });
      }

      const previousState = managed.codexRealtimeState;
      const wasStarting = previousState === "starting" || Boolean(managed.codexRealtimeStartInFlight);
      managed.codexRealtimeState = "stopping";
      const client = await getCodexAppServerClient();
      if (wasStarting) {
        // Keep the session busy until the matching start handler settles. This
        // prevents a normal turn/start from racing with a half-open realtime start.
        void withTimeout(
          client.request("thread/realtime/stop", { threadId: managed.codexThreadId }),
          2_000,
          "Codex realtime stop timed out during start cancellation",
        ).catch(() => undefined);
        return { ok: true, pendingStartCleanup: true };
      }

      try {
        await client.request("thread/realtime/stop", { threadId: managed.codexThreadId });
      } catch (err) {
        if (previousState !== "idle") {
          managed.codexRealtimeState = "error";
          managed.codexRealtimeStartInFlight = false;
          managed.codexRealtimeStartToken = null;
          managed.codexRealtimeError = err instanceof Error ? err.message : "Failed to stop Codex realtime";
          return reply.status(502).send({ error: managed.codexRealtimeError });
        }
      }

      managed.codexRealtimeState = "idle";
      managed.codexRealtimeStartInFlight = false;
      managed.codexRealtimeStartToken = null;
      return { ok: true };
    },
  );
}

async function cleanupRealtimeStartFailure(
  client: Awaited<ReturnType<typeof getCodexAppServerClient>>,
  managed: ManagedSession,
  threadId: string,
  startToken: string,
  message: string,
) {
  if (!isCurrentRealtimeStart(managed, startToken)) return;
  managed.codexRealtimeState = "stopping";
  managed.codexRealtimeError = message;
  broadcastEvent(managed, {
    type: "codex_realtime_error",
    message,
    seq: nextSeq(managed),
  });
  await stopRealtimeBestEffort(client, threadId);
  finishRealtimeStart(managed, startToken, "idle");
  broadcastEvent(managed, {
    type: "codex_realtime_closed",
    seq: nextSeq(managed),
  });
}

function isRealtimeBusy(managed: ManagedSession): boolean {
  return Boolean(
    managed.codexRealtimeStartInFlight ||
      managed.codexRealtimeState === "starting" ||
      managed.codexRealtimeState === "active" ||
      managed.codexRealtimeState === "stopping",
  );
}

function isCurrentRealtimeStart(managed: ManagedSession, token: string): boolean {
  return managed.codexRealtimeStartToken === token;
}

function finishRealtimeStart(
  managed: ManagedSession,
  token: string,
  state: "idle" | "active" | "error",
) {
  if (!isCurrentRealtimeStart(managed, token)) return;
  managed.codexRealtimeState = state;
  managed.codexRealtimeStartInFlight = false;
  managed.codexRealtimeStartToken = null;
}

async function stopRealtimeBestEffort(
  client: Awaited<ReturnType<typeof getCodexAppServerClient>>,
  threadId: string,
) {
  try {
    await withTimeout(
      client.request("thread/realtime/stop", { threadId }),
      2_000,
      "Codex realtime stop timed out",
    );
  } catch {
    // Best-effort cleanup: start can fail before the app-server creates a
    // realtime session. Text turns remain guarded by codexRealtimeStartInFlight
    // until the start handler settles.
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isRealtimeUnsupportedError(message: string): boolean {
  return message.includes("does not support realtime conversation");
}

function friendlyRealtimeStartError(message: string): string {
  if (isRealtimeUnsupportedError(message)) {
    return [
      "This Codex thread does not support realtime voice.",
      "Text chat can continue; use browser speech fallback or create a new Codex session for voice.",
    ].join(" ");
  }
  return message;
}

function waitForRealtimeSdp(
  client: Awaited<ReturnType<typeof getCodexAppServerClient>>,
  threadId: string,
  startToken: string,
  managed: ManagedSession,
): Promise<string | null> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, REALTIME_START_TIMEOUT_MS);

    unsubscribe = client.subscribeThread(threadId, (message: AppServerMessage) => {
      if (message.method !== "thread/realtime/sdp") return;
      if (!isCurrentRealtimeStart(managed, startToken)) {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(null);
        return;
      }
      const sdp = message.params?.sdp;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(typeof sdp === "string" ? sdp : null);
    });
  });
}
