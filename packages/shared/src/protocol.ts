import type { Message, SessionCapabilities, SessionStatus } from "./types.js";

// --- Structured prompt input ---

export interface PromptImageInput {
  base64: string;
  mimeType: string;
  name?: string;
}

export interface PromptSkillInput {
  name: string;
  path: string;
}

export interface PromptMentionInput {
  name: string;
  path: string;
}

// --- Server -> Client events (all carry a seq number) ---

export interface InitEvent { type: "init"; sessionId: string; seq: number; }
export interface TextDeltaEvent { type: "text_delta"; text: string; seq: number; }
export interface MessageCompleteEvent { type: "message_complete"; content: string; role: "assistant"; messageId?: string; seq: number; }
export interface ActiveToolActivity { id?: string; tool: string; input: unknown; timestamp: number; }
export interface ToolUseEvent { type: "tool_use"; tool: string; input: unknown; seq: number; id?: string; timestamp?: number; }
export interface ActiveToolsEvent { type: "active_tools"; activeTools: ActiveToolActivity[]; seq: number; }
export interface TurnCompleteEvent { type: "turn_complete"; cost?: number; seq: number; }
export interface ErrorEvent { type: "error"; message: string; seq: number; nonFatal?: boolean; code?: string; }
export interface StatusEvent { type: "status"; status: SessionStatus; seq: number; }
export interface SessionUpdatedEvent { type: "session_updated"; sessionId: string; name: string | null; seq: number; }

export interface PermissionRequestEvent {
  type: "permission_request";
  id: string;
  kind: "command" | "file" | "permissions" | "questions" | "elicitation" | "plan";
  toolName: string;
  input: Record<string, unknown>;
  allowForSession?: boolean;
  seq: number;
}

export interface PermissionResolvedEvent { type: "permission_resolved"; id: string; seq: number; }

export interface SessionCapabilitiesEvent {
  type: "session_capabilities";
  capabilities: SessionCapabilities;
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
  capabilities?: SessionCapabilities;
  pendingPermissions?: PermissionRequestEvent[];
  activeTools?: ActiveToolActivity[];
}

export interface TranscriptRefreshedEvent { type: "transcript_refreshed"; messages: Message[]; transcriptSource?: "codex-thread" | "db" | "db-fallback"; transcriptWarning?: string; seq: number; }
export interface TranscriptRefreshFailedEvent { type: "transcript_refresh_failed"; message: string; seq: number; }

// --- Experimental Codex realtime voice events ---
export interface CodexRealtimeStartedEvent { type: "codex_realtime_started"; seq: number; }
export interface CodexRealtimeTranscriptDeltaEvent { type: "codex_realtime_transcript_delta"; delta: string; seq: number; }
export interface CodexRealtimeTranscriptDoneEvent { type: "codex_realtime_transcript_done"; transcript: string; seq: number; }
export interface CodexRealtimeErrorEvent { type: "codex_realtime_error"; message: string; seq: number; }
export interface CodexRealtimeClosedEvent { type: "codex_realtime_closed"; seq: number; }

/** Raw chunk of CLI stdout, forwarded as-is for the embedded terminal Debug view. */
export interface RawStdoutEvent { type: "raw_stdout"; data: string; seq: number; }

export type ServerEvent =
  | InitEvent | TextDeltaEvent | MessageCompleteEvent | ToolUseEvent | ActiveToolsEvent | TurnCompleteEvent
  | ErrorEvent | StatusEvent | SessionUpdatedEvent | PermissionRequestEvent
  | PermissionResolvedEvent | SessionCapabilitiesEvent | TranscriptRefreshedEvent
  | TranscriptRefreshFailedEvent | CodexRealtimeStartedEvent
  | CodexRealtimeTranscriptDeltaEvent | CodexRealtimeTranscriptDoneEvent
  | CodexRealtimeErrorEvent | CodexRealtimeClosedEvent | RawStdoutEvent | SnapshotEvent;

// --- Lobby WebSocket events (cross-session, status-only broadcast) ---
export interface LobbySessionStatusEvent { type: "session_status"; sessionId: string; status: SessionStatus; }
export interface LobbySnapshotEvent { type: "lobby_snapshot"; statuses: Record<string, SessionStatus>; }
export type LobbyEvent = LobbySessionStatusEvent | LobbySnapshotEvent;

// --- Client -> Server messages ---

export interface SendPromptMessage {
  type: "send_prompt";
  content: string;
  images?: PromptImageInput[];
  skills?: PromptSkillInput[];
  mentions?: PromptMentionInput[];
}
export interface StopMessage { type: "stop"; }
export interface RetryMessage { type: "retry"; }
export interface RetryDesyncedTurnMessage { type: "retry_desynced_turn"; turnId: string; }
export interface SyncMessagesMessage { type: "sync_messages"; }
export interface RefreshTranscriptMessage { type: "refresh_transcript"; }
export interface ApprovePermissionMessage { type: "approve_permission"; id: string; }
export interface ApprovePermissionForSessionMessage { type: "approve_permission_for_session"; id: string; }
export interface RejectPermissionMessage { type: "reject_permission"; id: string; message?: string; }
export interface AnswerUserInputMessage { type: "answer_user_input"; id: string; answer: string; }

export type ClientMessage =
  | SendPromptMessage | StopMessage | RetryMessage | RetryDesyncedTurnMessage | SyncMessagesMessage | RefreshTranscriptMessage
  | ApprovePermissionMessage | ApprovePermissionForSessionMessage | RejectPermissionMessage | AnswerUserInputMessage;
