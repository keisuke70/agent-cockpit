import { useEffect, useRef } from "react";

interface TerminalViewProps {
  /** Live raw stdout buffer (truncated front when over budget). */
  data: string;
}

/**
 * Debug-only embedded "terminal" view. Renders raw CLI stdout in a monospace
 * `<pre>`. No xterm.js: Claude/Codex stream-json output is plain JSONL with no
 * ANSI, so a `<pre>` is sufficient and saves ~200KB of bundle.
 *
 * The view is live-only: reconnect drops anything that arrived while
 * disconnected (raw_stdout is excluded from the server eventBuffer).
 */
export function TerminalView({ data }: TerminalViewProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const userScrolled = useRef(false);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolled.current = !atBottom;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (!userScrolled.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [data]);

  return (
    <pre
      ref={preRef}
      style={{
        flex: 1,
        margin: 0,
        padding: "12px 16px",
        overflow: "auto",
        background: "#0a0a0a",
        color: "#a3e635",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {data ||
        "(no live output yet — send a prompt to see the agent CLI's raw stdout here)"}
    </pre>
  );
}
