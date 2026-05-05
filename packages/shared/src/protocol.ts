import type { Message, SessionStatus } from "./types.js";

// --- Server -> Client events (all carry a seq number) ---

export interface InitEvent {
  type: "init";
  sessionId: string;
  seq: number;
}

export interface TextDeltaEvent {
  type: "text_delta";
  text: string;
  seq: number;
}

export interface MessageCompleteEvent {
  type: "message_complete";
  content: string;
  role: "assistant";
  messageId?: string;
  seq: number;
}

export interface ToolUseEvent {
  type: "tool_use";
  tool: string;
  input: unknown;
  seq: number;
}

export interface TurnCompleteEvent {
  type: "turn_complete";
  cost?: number;
  seq: number;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  seq: number;
}

export interface StatusEvent {
  type: "status";
  status: SessionStatus;
  seq: number;
}

export interface SessionUpdatedEvent {
  type: "session_updated";
  sessionId: string;
  name: string | null;
  seq: number;
}

export interface SnapshotEvent {
  type: "snapshot";
  messages: Message[];
  lastSeq: number;
  status: SessionStatus;
  sessionName: string | null;
  transcriptSource?: "codex-thread" | "db" | "db-fallback";
  transcriptWarning?: string;
}

export interface TranscriptRefreshedEvent {
  type: "transcript_refreshed";
  messages: Message[];
  transcriptSource?: "codex-thread" | "db" | "db-fallback";
  transcriptWarning?: string;
  seq: number;
}

export interface TranscriptRefreshFailedEvent {
  type: "transcript_refresh_failed";
  message: string;
  seq: number;
}

/**
 * Raw chunk of CLI stdout, forwarded as-is for the embedded terminal Debug
 * view. Excluded from the eventBuffer (live-only, non-replayable across
 * reconnects). Carries seq for ordering with other events but reconnect
 * catch-up will not include it.
 */
export interface RawStdoutEvent {
  type: "raw_stdout";
  data: string;
  seq: number;
}

export type ServerEvent =
  | InitEvent
  | TextDeltaEvent
  | MessageCompleteEvent
  | ToolUseEvent
  | TurnCompleteEvent
  | ErrorEvent
  | StatusEvent
  | SessionUpdatedEvent
  | TranscriptRefreshedEvent
  | TranscriptRefreshFailedEvent
  | RawStdoutEvent
  | SnapshotEvent;

// --- Lobby WebSocket events (cross-session, status-only broadcast) ---

export interface LobbySessionStatusEvent {
  type: "session_status";
  sessionId: string;
  status: SessionStatus;
}

export interface LobbySnapshotEvent {
  type: "lobby_snapshot";
  /** Map of sessionId -> current status for all known managed sessions */
  statuses: Record<string, SessionStatus>;
}

export type LobbyEvent = LobbySessionStatusEvent | LobbySnapshotEvent;

// --- Client -> Server messages ---

export interface SendPromptMessage {
  type: "send_prompt";
  content: string;
}

export interface StopMessage {
  type: "stop";
}

export interface RetryMessage {
  type: "retry";
}

export interface SyncMessagesMessage {
  type: "sync_messages";
}

export interface RefreshTranscriptMessage {
  type: "refresh_transcript";
}

export type ClientMessage =
  | SendPromptMessage
  | StopMessage
  | RetryMessage
  | SyncMessagesMessage
  | RefreshTranscriptMessage;
