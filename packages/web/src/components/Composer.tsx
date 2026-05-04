import { useState, useRef, useEffect } from "react";
import { SLASH_COMMANDS, type SlashCommandDefinition, type SessionStatus } from "@agent-cockpit/shared";

interface ComposerProps {
  status: SessionStatus | "connecting";
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
}

export function Composer({ status, onSend, onStop, onRetry }: ComposerProps) {
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isRunning = status === "running";
  const isErrorOrStopped = status === "error" || status === "stopped";
  const canSend = text.trim().length > 0 && !isRunning && status !== "connecting";
  const slashQuery = getSlashQuery(text);
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter((cmd) => slashCommandMatches(cmd, slashQuery))
    : [];
  const showSlashMenu =
    slashMatches.length > 0 &&
    !slashMenuDismissed &&
    !isRunning &&
    status !== "connecting";
  const slashToken = slashQuery ? getSlashToken(text) : null;
  const exactSlashCommand = slashMatches.some(
    (cmd) => cmd.command === slashToken || cmd.aliases?.includes(slashToken ?? ""),
  );

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }
  }, [text]);

  useEffect(() => {
    setSlashIndex(0);
    setSlashMenuDismissed(false);
  }, [slashQuery]);

  useEffect(() => {
    if (slashIndex >= slashMatches.length) {
      setSlashIndex(Math.max(0, slashMatches.length - 1));
    }
  }, [slashIndex, slashMatches.length]);

  function handleSend() {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((prev) => (prev + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((prev) => (prev - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applySlashCommand(slashMatches[slashIndex]?.command);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !exactSlashCommand) {
        e.preventDefault();
        applySlashCommand(slashMatches[slashIndex]?.command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function applySlashCommand(command: string | undefined) {
    if (!command) return;
    const nextText = replaceLeadingSlashToken(text, command);
    setText(nextText);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const leadingWhitespace = nextText.match(/^\s*/)?.[0].length ?? 0;
      const cursor = leadingWhitespace + command.length;
      ta.setSelectionRange(cursor, cursor);
    });
  }

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "12px 16px",
        paddingBottom: "calc(12px + var(--safe-bottom))",
        background: "var(--bg)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 8,
        alignItems: "flex-end",
      }}
    >
      {isErrorOrStopped && (
        <button
          onClick={onRetry}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Retry
        </button>
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
        }}
      >
        {showSlashMenu && (
          <SlashMenu
            commands={slashMatches}
            activeIndex={slashIndex}
            onSelect={(command) => applySlashCommand(command)}
          />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashMenuDismissed(false);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a prompt...  / for commands"
          rows={1}
          aria-autocomplete="list"
          aria-controls={showSlashMenu ? "slash-command-menu" : undefined}
          aria-activedescendant={
            showSlashMenu ? `slash-command-option-${slashIndex}` : undefined
          }
          aria-expanded={showSlashMenu}
          style={{
            width: "100%",
            resize: "none",
            minHeight: 44,
            maxHeight: 120,
          }}
        />
      </div>
      {isRunning ? (
        <button
          onClick={onStop}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: "var(--radius-sm)",
            background: "var(--danger)",
            color: "white",
            fontWeight: 600,
          }}
        >
          Stop
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: "var(--radius-sm)",
            background: canSend ? "var(--accent)" : "var(--bg-surface)",
            color: canSend ? "white" : "var(--text-muted)",
            fontWeight: 600,
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}

function SlashMenu({
  commands,
  activeIndex,
  onSelect,
}: {
  commands: SlashCommandDefinition[];
  activeIndex: number;
  onSelect: (command: string) => void;
}) {
  return (
    <div
      id="slash-command-menu"
      role="listbox"
      aria-label="Slash commands"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        maxHeight: 240,
        overflowY: "auto",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-surface)",
        boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
        padding: 6,
        zIndex: 20,
      }}
    >
      {commands.map((cmd, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={cmd.command}
            id={`slash-command-option-${index}`}
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              // Prevent textarea blur before click/tap selection is applied.
              e.preventDefault();
              onSelect(cmd.command);
            }}
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              padding: "9px 10px",
              borderRadius: "var(--radius-sm)",
              background: active ? "var(--bg-hover)" : "transparent",
              border: active ? "1px solid var(--border)" : "1px solid transparent",
              textAlign: "left",
            }}
          >
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 13,
                color: "var(--text)",
                fontWeight: 700,
              }}
            >
              {cmd.command}
              {cmd.aliases?.length ? (
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>
                  {" "}
                  ({cmd.aliases.join(", ")})
                </span>
              ) : null}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {cmd.description}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getSlashQuery(value: string): string | null {
  const trimmedStart = value.replace(/^\s+/, "");
  if (!trimmedStart.startsWith("/")) return null;
  return getSlashToken(trimmedStart);
}

function getSlashToken(value: string): string | null {
  const token = value.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
  return token?.startsWith("/") ? token : null;
}

function replaceLeadingSlashToken(value: string, command: string): string {
  const match = value.match(/^(\s*)\S*(.*)$/s);
  if (!match) return command;
  return `${match[1]}${command}${match[2]}`;
}

function slashCommandMatches(command: SlashCommandDefinition, query: string): boolean {
  return (
    command.command.startsWith(query) ||
    Boolean(command.aliases?.some((alias) => alias.startsWith(query)))
  );
}
