import { useEffect, useRef, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router";
import type { GitStatus } from "@agent-cockpit/shared";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useSession } from "../hooks/useSession.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useRepoSessions } from "../hooks/useRepoSessions.js";
import { useSwipeNavigation } from "../hooks/useSwipeNavigation.js";
import { StreamOutput } from "../components/StreamOutput.js";
import { TerminalView } from "../components/TerminalView.js";
import { Composer } from "../components/Composer.js";
import { SchedulePanel } from "../components/SchedulePanel.js";

type ViewMode = "chat" | "debug";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const session = useSession(id!);
  const { messages, streamingText, rawStdout, status, sendPrompt, stop, retry } =
    useWebSocket(id!);
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const { status: gitStatus, refresh: refreshGit } = useGitStatus(session?.repoId);
  const repoSessions = useRepoSessions(session?.repoId);

  // Refresh git status one extra time when a turn just completed (running -> idle).
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === "running" && status !== "running") {
      refreshGit();
    }
    prevStatusRef.current = status;
  }, [status, refreshGit]);

  // Find sibling sessions for swipe navigation (in updated_at desc order from API).
  const { prevId, nextId, currentIndex, totalCount } = useMemo(() => {
    const idx = repoSessions.findIndex((s) => s.id === id);
    return {
      currentIndex: idx,
      totalCount: repoSessions.length,
      prevId: idx > 0 ? repoSessions[idx - 1].id : null,
      nextId: idx >= 0 && idx < repoSessions.length - 1 ? repoSessions[idx + 1].id : null,
    };
  }, [repoSessions, id]);

  const swipeHandlers = useSwipeNavigation({
    onSwipeLeft: () => {
      if (nextId) navigate(`/session/${nextId}`);
    },
    onSwipeRight: () => {
      if (prevId) navigate(`/session/${prevId}`);
    },
  });

  const displayName = session?.name || `Session ${id?.slice(0, 8)}`;
  const agent = session?.agent ?? "";

  return (
    <>
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{ fontSize: 20, padding: "4px 8px", minWidth: 44, minHeight: 44 }}
          aria-label="Back"
        >
          &larr;
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {displayName}
            {agent && (
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                }}
              >
                {agent}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <StatusLabel status={status} />
            {gitStatus && <GitBadge status={gitStatus} />}
          </div>
        </div>
        {totalCount > 1 && currentIndex >= 0 && (
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              marginRight: 4,
            }}
            title="Swipe left/right to switch sessions"
          >
            {currentIndex + 1}/{totalCount}
          </span>
        )}
        <button
          onClick={() => setViewMode(viewMode === "chat" ? "debug" : "chat")}
          style={{
            fontSize: 11,
            padding: "4px 10px",
            borderRadius: 999,
            background: viewMode === "debug" ? "var(--accent)" : "var(--bg-surface)",
            color: viewMode === "debug" ? "white" : "var(--text-muted)",
            border: "1px solid var(--border)",
            fontWeight: 600,
            minHeight: 28,
          }}
          aria-label="Toggle Chat / Debug view"
          title="Toggle Chat / Debug view (live raw stdout, non-replayable)"
        >
          {viewMode === "debug" ? "Debug" : "Chat"}
        </button>
        <StatusDot status={status} />
      </header>

      <SchedulePanel sessionId={id!} />

      <div
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        {...swipeHandlers}
      >
        {viewMode === "chat" ? (
          <StreamOutput messages={messages} streamingText={streamingText} />
        ) : (
          <TerminalView data={rawStdout} />
        )}
      </div>
      <Composer status={status} onSend={sendPrompt} onStop={stop} onRetry={retry} />
    </>
  );
}

function GitBadge({ status }: { status: GitStatus }) {
  let label: string;
  let color = "var(--text-muted)";
  if (!status.dirty) {
    label = status.branch;
  } else if (status.insertions + status.deletions > 0) {
    label = `${status.branch} · +${status.insertions}/-${status.deletions} (${status.filesChanged} files)`;
    color = "var(--accent)";
  } else {
    label = `${status.branch} · ${status.filesChanged} new`;
    color = "var(--accent)";
  }
  return (
    <span
      style={{
        fontSize: 12,
        padding: "2px 8px",
        borderRadius: 999,
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        color,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: 200,
      }}
      title={label}
    >
      {label}
    </span>
  );
}

function StatusLabel({ status }: { status: string }) {
  switch (status) {
    case "connecting":
      return <>Connecting...</>;
    case "running":
      return <>Running...</>;
    case "error":
      return <span style={{ color: "var(--danger)" }}>Error</span>;
    case "stopped":
      return <>Stopped</>;
    default:
      return <>Ready</>;
  }
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "running"
      ? "var(--success)"
      : status === "error"
        ? "var(--danger)"
        : status === "connecting"
          ? "var(--accent)"
          : "var(--text-muted)";

  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        ...(status === "running" || status === "connecting"
          ? { animation: "blink 1.5s ease-in-out infinite" }
          : {}),
      }}
    />
  );
}
