import type { AdapterHandle } from "./adapters/base.js";
import type { CLIAdapter } from "./adapters/base.js";
import type { LobbyEvent, ServerEvent } from "@agent-cockpit/shared";

export interface ManagedSession {
  sessionId: string;
  runtime: "cli" | "codex-app-server";
  adapter?: CLIAdapter;
  handle?: AdapterHandle;
  codexThreadId?: string;
  codexActiveTurnId?: string | null;
  codexStopRequested?: boolean;
  codexStoppingTurnId?: string | null;
  cleanup?: () => void;
  seq: number;
  eventBuffer: ServerEvent[];
  listeners: Set<(event: ServerEvent) => void>;
}

const sessions = new Map<string, ManagedSession>();

/** Cross-session lobby listeners (one per /ws/lobby connection). */
const lobbyListeners = new Set<(event: LobbyEvent) => void>();

const EVENT_BUFFER_MAX = 500;

export function getManaged(sessionId: string): ManagedSession | undefined {
  return sessions.get(sessionId);
}

export function setManaged(sessionId: string, managed: ManagedSession) {
  sessions.set(sessionId, managed);
}

export function removeManaged(sessionId: string) {
  const managed = sessions.get(sessionId);
  if (managed) {
    managed.cleanup?.();
    if (managed.runtime === "cli" && managed.adapter && managed.handle) {
      managed.adapter.dispose(managed.handle);
    }
    managed.listeners.clear();
    sessions.delete(sessionId);
  }
}

export function nextSeq(managed: ManagedSession): number {
  return ++managed.seq;
}

export function broadcastEvent(managed: ManagedSession, event: ServerEvent) {
  // Raw stdout is high-volume, debug-only, and live-only. Excluded from the
  // reconnect buffer so it does not blow EVENT_BUFFER_MAX. Reconnect clients
  // will not see raw stdout that arrived while they were disconnected; they
  // will only see new raw_stdout events going forward.
  if (event.type !== "raw_stdout") {
    managed.eventBuffer.push(event);
    if (managed.eventBuffer.length > EVENT_BUFFER_MAX) {
      managed.eventBuffer.shift();
    }
  }
  for (const listener of managed.listeners) {
    listener(event);
  }
}

export function getEventsSince(
  managed: ManagedSession,
  lastSeq: number,
): ServerEvent[] | null {
  // Find events after lastSeq
  const events = managed.eventBuffer.filter(
    (e) => "seq" in e && (e as any).seq > lastSeq,
  );
  if (events.length === 0 && managed.eventBuffer.length > 0) {
    // Check if lastSeq is older than our buffer
    const firstBuffered = managed.eventBuffer[0];
    if ("seq" in firstBuffered && (firstBuffered as any).seq > lastSeq) {
      return null; // Need full snapshot
    }
  }
  return events;
}

export function cleanupAll() {
  for (const [id] of sessions) {
    removeManaged(id);
  }
}

// --- Lobby (cross-session) ---

export function addLobbyListener(fn: (event: LobbyEvent) => void) {
  lobbyListeners.add(fn);
}

export function removeLobbyListener(fn: (event: LobbyEvent) => void) {
  lobbyListeners.delete(fn);
}

export function broadcastLobby(event: LobbyEvent) {
  for (const listener of lobbyListeners) {
    listener(event);
  }
}
