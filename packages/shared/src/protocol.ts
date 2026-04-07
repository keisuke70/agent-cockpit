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

export interface SnapshotEvent {
  type: "snapshot";
  messages: Message[];
  lastSeq: number;
  status: SessionStatus;
}

export type ServerEvent =
  | InitEvent
  | TextDeltaEvent
  | MessageCompleteEvent
  | ToolUseEvent
  | TurnCompleteEvent
  | ErrorEvent
  | StatusEvent
  | SnapshotEvent;

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

export type ClientMessage = SendPromptMessage | StopMessage | RetryMessage;
