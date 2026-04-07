import type { AdapterHandle } from "./adapters/base.js";
import type { CLIAdapter } from "./adapters/base.js";
import type { ServerEvent } from "@agent-cockpit/shared";

export interface ManagedSession {
  sessionId: string;
  adapter: CLIAdapter;
  handle: AdapterHandle;
  seq: number;
  eventBuffer: ServerEvent[];
  listeners: Set<(event: ServerEvent) => void>;
}

const sessions = new Map<string, ManagedSession>();

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
    managed.adapter.dispose(managed.handle);
    managed.listeners.clear();
    sessions.delete(sessionId);
  }
}

export function nextSeq(managed: ManagedSession): number {
  return ++managed.seq;
}

export function broadcastEvent(managed: ManagedSession, event: ServerEvent) {
  managed.eventBuffer.push(event);
  if (managed.eventBuffer.length > EVENT_BUFFER_MAX) {
    managed.eventBuffer.shift();
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
