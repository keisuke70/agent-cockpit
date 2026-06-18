export type CodexTerminalStatus = "completed" | "interrupted" | "failed" | "error";

export interface CodexLocalTurnSnapshot {
  id: string;
  status?: string | null;
  codexTurnId?: string | null;
  codexSyncStatus?: string | null;
  messageSource?: string | null;
}

export type CodexTerminalDecision =
  | { action: "apply"; terminal: CodexTerminalStatus; localTurnId: string; sessionStatus: "idle" | "stopped" | "error"; turnStatus: "complete" | "stopped" | "error" }
  | { action: "ignore"; reason: "missing-terminal-id" | "no-running-turn" | "unmatched-terminal" | "awaiting-start" };

const AWAITING_START_SYNC_STATUSES = new Set(["local_only", "submit_inflight"]);

export function isCodexTurnAwaitingStart(turn: CodexLocalTurnSnapshot | null | undefined): boolean {
  if (!turn) return false;
  return !turn.codexTurnId && AWAITING_START_SYNC_STATUSES.has(String(turn.codexSyncStatus ?? ""));
}

export function isCodexTerminalStatus(value: unknown): value is CodexTerminalStatus {
  return value === "completed" || value === "interrupted" || value === "failed" || value === "error";
}

export function terminalBelongsToLocalTurn(
  turn: CodexLocalTurnSnapshot | null | undefined,
  terminalTurnId: string | null | undefined,
): boolean {
  return Boolean(turn?.codexTurnId && terminalTurnId && turn.codexTurnId === terminalTurnId);
}

export function shouldIgnoreTerminalForDifferentRunningTurn(
  currentRunningTurn: CodexLocalTurnSnapshot | null | undefined,
  mappedLocalTurnId: string | null | undefined,
): boolean {
  return Boolean(currentRunningTurn?.id && mappedLocalTurnId && currentRunningTurn.id !== mappedLocalTurnId);
}

export function decideCodexTerminalTransition(
  turn: CodexLocalTurnSnapshot | null | undefined,
  terminalTurnId: string | null | undefined,
  terminal: CodexTerminalStatus,
): CodexTerminalDecision {
  if (!turn) return { action: "ignore", reason: "no-running-turn" };
  if (!terminalTurnId) return { action: "ignore", reason: "missing-terminal-id" };
  if (isCodexTurnAwaitingStart(turn)) return { action: "ignore", reason: "awaiting-start" };
  if (!terminalBelongsToLocalTurn(turn, terminalTurnId)) {
    return { action: "ignore", reason: "unmatched-terminal" };
  }
  if (terminal === "completed") {
    return { action: "apply", terminal, localTurnId: turn.id, sessionStatus: "idle", turnStatus: "complete" };
  }
  if (terminal === "interrupted") {
    return { action: "apply", terminal, localTurnId: turn.id, sessionStatus: "stopped", turnStatus: "stopped" };
  }
  return { action: "apply", terminal, localTurnId: turn.id, sessionStatus: "error", turnStatus: "error" };
}
