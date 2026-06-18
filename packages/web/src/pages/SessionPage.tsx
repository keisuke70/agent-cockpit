import { useEffect, useRef, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router";
import type { GitStatus } from "@agent-cockpit/shared";
import { useWebSocket } from "../hooks/useWebSocket.js";
import { useSession } from "../hooks/useSession.js";
import { useGitStatus } from "../hooks/useGitStatus.js";
import { useRepoSessions } from "../hooks/useRepoSessions.js";
import { authHeaders } from "../hooks/useAuth.js";
import { StreamOutput } from "../components/StreamOutput.js";
import { TerminalView } from "../components/TerminalView.js";
import { Composer } from "../components/Composer.js";
import { SchedulePanel } from "../components/SchedulePanel.js";
import { sessionDisplayName } from "../sessionDisplay.js";

type ViewMode = "chat" | "debug";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const session = useSession(id!);
  const {
    messages,
    streamingText,
    activeTools,
    rawStdout,
    status,
    sessionName,
    refreshingTranscript,
    transcriptRefreshError,
    capabilities,
    pendingPermissions,
    sendPrompt,
    refreshTranscript,
    stop,
    retry,
    retryDesyncedTurn,
    approvePermission,
    approvePermissionForSession,
    rejectPermission,
    answerUserInput,
  } = useWebSocket(id!);
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
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

  // Find sibling sessions for explicit header navigation (in updated_at desc order from API).
  const { prevId, nextId, currentIndex, totalCount } = useMemo(() => {
    const idx = repoSessions.findIndex((s) => s.id === id);
    return {
      currentIndex: idx,
      totalCount: repoSessions.length,
      prevId: idx > 0 ? repoSessions[idx - 1].id : null,
      nextId: idx >= 0 && idx < repoSessions.length - 1 ? repoSessions[idx + 1].id : null,
    };
  }, [repoSessions, id]);

  const displayName =
    sessionName !== undefined
      ? sessionDisplayName({ id: id!, name: sessionName })
      : session
        ? sessionDisplayName(session)
        : "Loading session";
  const agent = session?.agent ?? "";

  async function deleteSession() {
    if (!id || isDeleting) return;
    const confirmed = confirm(
      `Delete "${displayName}"? This removes its messages and schedules.`,
    );
    if (!confirmed) return;

    setIsDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error ?? `Delete failed (${res.status})`);
        return;
      }

      navigate("/", { replace: true });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <header className="session-header">
        <button
          className="session-back-button"
          onClick={() => navigate("/")}
          aria-label="Back to sessions"
        >
          &larr;
        </button>
        <div className="session-heading">
          <div className="session-title-row">
            <h1 className="session-title">{displayName}</h1>
            {agent && <span className="session-agent-pill">{agent}</span>}
          </div>
          <div className="session-meta-row">
            <StatusLabel status={status} />
            {gitStatus && <GitBadge status={gitStatus} />}
            {deleteError && (
              <span role="alert" style={{ color: "var(--danger)" }}>
                {deleteError}
              </span>
            )}
            {transcriptRefreshError && (
              <span role="alert" style={{ color: "var(--danger)" }}>
                Notice: {transcriptRefreshError}
              </span>
            )}
          </div>
        </div>
        <StatusDot status={status} />
      </header>

      <div className="session-action-bar" role="group" aria-label="Session controls">
        {totalCount > 1 && currentIndex >= 0 && (
          <SessionNavigator
            current={currentIndex + 1}
            total={totalCount}
            hasNewer={Boolean(prevId)}
            hasOlder={Boolean(nextId)}
            onNewer={() => {
              if (prevId) navigate(`/session/${prevId}`, { replace: true });
            }}
            onOlder={() => {
              if (nextId) navigate(`/session/${nextId}`, { replace: true });
            }}
          />
        )}
        {session?.agent === "codex" && (
          <button
            className="session-chip-button"
            type="button"
            onClick={refreshTranscript}
            disabled={refreshingTranscript || status === "connecting" || status === "running"}
            title="Re-read the Codex thread transcript"
          >
            {refreshingTranscript ? "Refreshing" : "Refresh"}
          </button>
        )}
        <button
          className={`session-chip-button ${viewMode === "debug" ? "session-chip-button--active" : ""}`}
          onClick={() => setViewMode(viewMode === "chat" ? "debug" : "chat")}
          aria-pressed={viewMode === "debug"}
          title="Toggle Chat / Debug view (live raw stdout, non-replayable)"
        >
          {viewMode === "debug" ? "Debug view" : "Chat view"}
        </button>
        <button
          className="session-chip-button session-chip-button--danger"
          type="button"
          onClick={deleteSession}
          disabled={isDeleting}
        >
          {isDeleting ? "Deleting" : "Delete"}
        </button>
      </div>

      <SchedulePanel sessionId={id!} />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          touchAction: "pan-y",
          overscrollBehaviorX: "contain",
        }}
      >
        {viewMode === "chat" ? (
          <StreamOutput
            messages={messages}
            streamingText={streamingText}
            activeTools={activeTools}
            pendingPermissions={pendingPermissions}
            onApprovePermission={approvePermission}
            onApprovePermissionForSession={approvePermissionForSession}
            onRejectPermission={rejectPermission}
            onAnswerUserInput={answerUserInput}
            onRetryDesyncedTurn={retryDesyncedTurn}
          />
        ) : (
          <TerminalView data={rawStdout} />
        )}
      </div>
        <Composer
          status={status}
          capabilities={capabilities}
          onSend={sendPrompt}
          onStop={stop}
          onRetry={retry}
      />
    </>
  );
}

function SessionNavigator({
  current,
  total,
  hasNewer,
  hasOlder,
  onNewer,
  onOlder,
}: {
  current: number;
  total: number;
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}) {
  return (
    <nav
      aria-label="Session navigation"
      className="session-navigator"
    >
      <button
        type="button"
        disabled={!hasNewer}
        onClick={onNewer}
        aria-label="Newer session"
        title="Newer session"
        className="session-nav-button"
      >
        ‹
      </button>
      <span
        aria-current="page"
        className="session-nav-count"
        title="Current session position"
      >
        {current}/{total}
      </span>
      <button
        type="button"
        disabled={!hasOlder}
        onClick={onOlder}
        aria-label="Older session"
        title="Older session"
        className="session-nav-button"
      >
        ›
      </button>
    </nav>
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
        maxWidth: "100%",
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
      aria-hidden="true"
      className="session-status-dot"
      style={{
        background: color,
        ...(status === "running" || status === "connecting"
          ? { animation: "blink 1.5s ease-in-out infinite" }
          : {}),
      }}
    />
  );
}
