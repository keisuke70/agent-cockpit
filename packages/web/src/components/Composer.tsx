import { useState, useRef, useEffect, type KeyboardEvent, type ReactNode } from "react";
import {
  SLASH_COMMANDS,
  type PromptImageInput,
  type PromptMentionInput,
  type PromptSkillInput,
  type SessionCapabilities,
  type SessionStatus,
  type SlashCommandDefinition,
} from "@agent-cockpit/shared";

interface ComposerProps {
  status: SessionStatus | "connecting";
  capabilities?: SessionCapabilities | null;
  onSend: (
    text: string,
    options?: {
      images?: PromptImageInput[];
      skills?: PromptSkillInput[];
      mentions?: PromptMentionInput[];
    },
  ) => void;
  onStop: () => void;
  onRetry: () => void;
}

type EntityOption =
  | { type: "skill"; label: string; description?: string; value: PromptSkillInput }
  | { type: "mention"; label: string; description?: string; value: PromptMentionInput; kind: "app" | "plugin" };


type SlashArgOption = {
  label: string;
  value: string;
  description?: string;
  badge?: string;
};

export function Composer({
  status,
  capabilities,
  onSend,
  onStop,
  onRetry,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImageInput[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashArgIndex, setSlashArgIndex] = useState(0);
  const [entityIndex, setEntityIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [slashArgMenuDismissed, setSlashArgMenuDismissed] = useState(false);
  const [entityMenuDismissed, setEntityMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isRunning = status === "running";
  const isErrorOrStopped = status === "error" || status === "stopped";
  const canSend =
    (text.trim().length > 0 || images.length > 0) &&
    !isRunning &&
    status !== "connecting";
  const slashQuery = getSlashQuery(text);
  const slashArgQuery = getSlashArgQuery(text);
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter(
        (cmd) => cmd.support !== "recognized" && slashCommandMatches(cmd, slashQuery),
      )
    : [];
  const showSlashMenu =
    !slashArgQuery &&
    slashMatches.length > 0 &&
    !slashMenuDismissed &&
    !isRunning &&
    status !== "connecting";
  const slashToken = slashQuery ? getSlashToken(text) : null;
  const exactSlashCommand = slashMatches.some(
    (cmd) => cmd.command === slashToken || cmd.aliases?.includes(slashToken ?? ""),
  );
  const slashArgMatches = slashArgQuery
    ? getSlashArgOptions(slashArgQuery.command, slashArgQuery.query, capabilities)
    : [];
  const showSlashArgMenu =
    slashArgMatches.length > 0 &&
    !showSlashMenu &&
    !slashArgMenuDismissed &&
    !isRunning &&
    status !== "connecting";
  const entityQuery = !showSlashMenu && !showSlashArgMenu ? getEntityQuery(text) : null;
  const entityMatches = entityQuery
    ? getEntityOptions(capabilities, entityQuery.kind, entityQuery.query)
    : [];
  const showEntityMenu =
    entityMatches.length > 0 &&
    !entityMenuDismissed &&
    !isRunning &&
    status !== "connecting";

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
    setEntityIndex(0);
    setEntityMenuDismissed(false);
  }, [entityQuery?.token]);

  useEffect(() => {
    setSlashArgIndex(0);
    setSlashArgMenuDismissed(false);
  }, [slashArgQuery?.token]);

  useEffect(() => {
    if (slashIndex >= slashMatches.length) {
      setSlashIndex(Math.max(0, slashMatches.length - 1));
    }
  }, [slashIndex, slashMatches.length]);

  useEffect(() => {
    if (entityIndex >= entityMatches.length) {
      setEntityIndex(Math.max(0, entityMatches.length - 1));
    }
  }, [entityIndex, entityMatches.length]);

  useEffect(() => {
    if (slashArgIndex >= slashArgMatches.length) {
      setSlashArgIndex(Math.max(0, slashArgMatches.length - 1));
    }
  }, [slashArgIndex, slashArgMatches.length]);


  function handleSend() {
    if (!canSend) return;
    const structured = extractStructuredInputs(text, capabilities);
    onSend(text.trim(), { ...structured, images });
    setText("");
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
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

    if (showEntityMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEntityIndex((prev) => (prev + 1) % entityMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setEntityIndex((prev) => (prev - 1 + entityMatches.length) % entityMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applyEntity(entityMatches[entityIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEntityMenuDismissed(true);
        return;
      }
    }

    if (showSlashArgMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashArgIndex((prev) => (prev + 1) % slashArgMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashArgIndex((prev) => (prev - 1 + slashArgMatches.length) % slashArgMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySlashArg(slashArgMatches[slashArgIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashArgMenuDismissed(true);
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
    const replacement = commandSupportsArgumentCompletion(command) ? `${command} ` : command;
    const nextText = replaceLeadingSlashToken(text, replacement);
    setText(nextText);
    setSlashMenuDismissed(true);
    setSlashArgMenuDismissed(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const leadingWhitespace = nextText.match(/^\s*/)?.[0].length ?? 0;
      const cursor = leadingWhitespace + replacement.length;
      ta.setSelectionRange(cursor, cursor);
    });
  }

  function applyEntity(entity: EntityOption | undefined) {
    if (!entityQuery || !entity) return;
    const prefix = entity.type === "skill" ? "$" : "@";
    const replacement = `${prefix}${entity.label} `;
    const nextText = `${text.slice(0, entityQuery.start)}${replacement}${text.slice(entityQuery.end)}`;
    setText(nextText);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = entityQuery.start + replacement.length;
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  }

  function applySlashArg(option: SlashArgOption | undefined) {
    if (!slashArgQuery || !option) return;
    const needsTrailingSpace = !option.value.endsWith("=");
    const needsLeadingSpace = slashArgQuery.start > 0 && !/\s/.test(text[slashArgQuery.start - 1] ?? "");
    const replacement = `${needsLeadingSpace ? " " : ""}${option.value}${needsTrailingSpace ? " " : ""}`;
    const nextText = `${text.slice(0, slashArgQuery.start)}${replacement}${text.slice(slashArgQuery.end)}`;
    setText(nextText);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = slashArgQuery.start + replacement.length;
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  }

  async function handleImages(files: FileList | null) {
    if (!files?.length) return;
    const next = await Promise.all(
      Array.from(files).map(async (file) => ({
        base64: await readFileAsDataUrl(file),
        mimeType: file.type || "application/octet-stream",
        name: file.name,
      })),
    );
    setImages((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
        <button className="composer-secondary-button" type="button" onClick={onRetry}>
          Retry
        </button>
      )}
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        {showSlashMenu && (
          <SlashMenu
            commands={slashMatches}
            activeIndex={slashIndex}
            onSelect={(command) => applySlashCommand(command)}
          />
        )}
        {showEntityMenu && (
          <EntityMenu
            options={entityMatches}
            activeIndex={entityIndex}
            trigger={entityQuery?.kind ?? "skill"}
            onSelect={applyEntity}
          />
        )}
        {showSlashArgMenu && (
          <SlashArgMenu
            command={slashArgQuery?.command ?? ""}
            options={slashArgMatches}
            activeIndex={slashArgIndex}
            onSelect={applySlashArg}
          />
        )}
        {images.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images">
            {images.map((image, index) => (
              <span key={`${image.name}-${index}`} className="composer-attachment-chip">
                {image.name || image.mimeType}
                <button
                  type="button"
                  aria-label={`Remove ${image.name || "image"}`}
                  onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlashMenuDismissed(false);
            setSlashArgMenuDismissed(false);
            setEntityMenuDismissed(false);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a prompt... / commands, $ skills, @ apps/plugins"
          rows={1}
          aria-autocomplete="list"
          aria-controls={
            showSlashMenu
              ? "slash-command-menu"
              : showSlashArgMenu
                ? "slash-arg-menu"
                : showEntityMenu
                  ? "entity-menu"
                  : undefined
          }
          aria-activedescendant={
            showSlashMenu
              ? `slash-command-option-${slashIndex}`
              : showSlashArgMenu
                ? `slash-arg-option-${slashArgIndex}`
              : showEntityMenu
                ? `entity-option-${entityIndex}`
                : undefined
          }
          aria-expanded={showSlashMenu || showSlashArgMenu || showEntityMenu}
          style={{ width: "100%", resize: "none", minHeight: 44, maxHeight: 120 }}
        />
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void handleImages(event.target.files)}
      />
      <button
        className="composer-secondary-button"
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={isRunning || status === "connecting"}
        aria-label="Attach image"
        title="Attach image"
      >
        +
      </button>
      {isRunning ? (
        <button className="composer-stop-button" type="button" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="composer-send-button" type="button" onClick={handleSend} disabled={!canSend}>
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
    <PopupMenu id="slash-command-menu" label="Slash commands" heading={`${commands.length} command${commands.length === 1 ? "" : "s"}`} hint="↑↓ / Tab / tap">
      {commands.map((cmd, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={cmd.command}
            id={`slash-command-option-${index}`}
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd.command);
            }}
            className="composer-menu-option"
            style={{ background: active ? "var(--bg-hover)" : "transparent" }}
          >
            <span className="composer-menu-title-row">
              <span className="composer-menu-title">
                {cmd.command}
                {cmd.aliases?.length ? <span className="composer-menu-muted"> ({cmd.aliases.join(", ")})</span> : null}
              </span>
              <span className="composer-support-pill" style={{ color: supportColor(cmd.support) }}>
                {cmd.support === "codex-app-server" ? "codex" : cmd.support}
              </span>
            </span>
            <span className="composer-menu-description">{cmd.description}</span>
            <span className="composer-menu-description">{cmd.category}</span>
          </div>
        );
      })}
    </PopupMenu>
  );
}

function EntityMenu({
  options,
  activeIndex,
  trigger,
  onSelect,
}: {
  options: EntityOption[];
  activeIndex: number;
  trigger: "skill" | "mention";
  onSelect: (option: EntityOption) => void;
}) {
  return (
    <PopupMenu id="entity-menu" label={`${trigger} completions`} heading={`${options.length} ${trigger}${options.length === 1 ? "" : "s"}`} hint="↑↓ / Tab / tap">
      {options.map((option, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={`${option.type}-${option.label}-${index}`}
            id={`entity-option-${index}`}
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(option);
            }}
            className="composer-menu-option"
            style={{ background: active ? "var(--bg-hover)" : "transparent" }}
          >
            <span className="composer-menu-title-row">
              <span className="composer-menu-title">{option.type === "skill" ? "$" : "@"}{option.label}</span>
              <span className="composer-support-pill">{option.type === "skill" ? "skill" : option.kind}</span>
            </span>
            {option.description && <span className="composer-menu-description">{option.description}</span>}
          </div>
        );
      })}
    </PopupMenu>
  );
}

function SlashArgMenu({
  command,
  options,
  activeIndex,
  onSelect,
}: {
  command: string;
  options: SlashArgOption[];
  activeIndex: number;
  onSelect: (option: SlashArgOption) => void;
}) {
  return (
    <PopupMenu
      id="slash-arg-menu"
      label={`${command} options`}
      heading={`${options.length} option${options.length === 1 ? "" : "s"}`}
      hint="↑↓ / Tab / tap"
    >
      {options.map((option, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={`${option.value}-${index}`}
            id={`slash-arg-option-${index}`}
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(option);
            }}
            className="composer-menu-option"
            style={{ background: active ? "var(--bg-hover)" : "transparent" }}
          >
            <span className="composer-menu-title-row">
              <span className="composer-menu-title">{option.label}</span>
              {option.badge && <span className="composer-support-pill">{option.badge}</span>}
            </span>
            {option.description && <span className="composer-menu-description">{option.description}</span>}
          </div>
        );
      })}
    </PopupMenu>
  );
}

function PopupMenu({
  id,
  label,
  heading,
  hint,
  children,
}: {
  id: string;
  label: string;
  heading: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div id={id} role="listbox" aria-label={label} className="composer-menu">
      <div className="composer-menu-header">
        <span>{heading}</span>
        <span>{hint}</span>
      </div>
      {children}
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

function getSlashArgQuery(value: string): {
  command: string;
  query: string;
  token: string;
  start: number;
  end: number;
} | null {
  const match = value.match(/^(\s*)(\/\S+)(?:(\s+)(.*))?$/s);
  if (!match) return null;
  const command = match[2].toLowerCase();
  if (!commandSupportsArgumentCompletion(command)) return null;

  const hasArgSeparator = match[3] !== undefined;
  const args = match[4] ?? "";

  // Show second-stage choices as soon as the command is an exact match, even
  // before the user types a trailing space. Partial commands like `/mo` still
  // use the normal slash-command menu.
  if (!hasArgSeparator && value.trim() !== command) return null;

  const lastTokenMatch = args.match(/(?:^|\s)(\S*)$/);
  const token = hasArgSeparator ? lastTokenMatch?.[1] ?? "" : "";
  const argsStart = match[1].length + match[2].length + (match[3]?.length ?? 0);
  const start = hasArgSeparator ? argsStart + args.length - token.length : value.length;
  return {
    command: normalizeSlashAlias(command),
    query: token.toLowerCase(),
    token,
    start,
    end: value.length,
  };
}

function commandSupportsArgumentCompletion(command: string): boolean {
  return ["/model", "/models", "/reasoning", "/reason", "/permissions", "/approval", "/approvals", "/plan"].includes(
    command.toLowerCase(),
  );
}

function normalizeSlashAlias(command: string): string {
  switch (command) {
    case "/models":
      return "/model";
    case "/reason":
      return "/reasoning";
    case "/approval":
    case "/approvals":
      return "/permissions";
    default:
      return command;
  }
}

function replaceLeadingSlashToken(value: string, command: string): string {
  const match = value.match(/^(\s*)\S*(.*)$/s);
  if (!match) return command;
  return `${match[1]}${command}${match[2]}`;
}

function getSlashArgOptions(
  command: string,
  query: string,
  capabilities: SessionCapabilities | null | undefined,
): SlashArgOption[] {
  switch (command) {
    case "/model":
      return modelArgOptions(query, capabilities);
    case "/reasoning":
      return ["minimal", "low", "medium", "high", "xhigh"]
        .filter((effort) => effort.includes(query))
        .map((effort) => ({
          label: effort,
          value: effort,
          description:
            capabilities?.codexSettings?.reasoningEffort === effort
              ? "Current session setting"
              : reasoningDescription(effort),
          badge: capabilities?.codexSettings?.reasoningEffort === effort ? "current" : undefined,
        }));
    case "/permissions":
      return permissionArgOptions(query, capabilities);
    case "/plan":
      return ["on", "off", "default"]
        .filter((option) => option.includes(query))
        .map((option) => ({
          label: option,
          value: option,
          description: option === "on" ? "Enable Plan mode" : "Return to Default mode",
          badge:
            (option === "on" && capabilities?.codexSettings?.collaborationMode === "plan") ||
            ((option === "off" || option === "default") &&
              capabilities?.codexSettings?.collaborationMode === "default")
              ? "current"
              : undefined,
        }));
    default:
      return [];
  }
}

function modelArgOptions(
  query: string,
  capabilities: SessionCapabilities | null | undefined,
): SlashArgOption[] {
  const models = (capabilities?.models ?? [])
        .filter((model) => {
          const haystack = `${model.id} ${model.label}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, 12)
        .map((model) => ({
          label: model.label,
          value: model.id,
          description: model.id,
          badge: model.isDefault ? "default" : model.defaultReasoningEffort ?? undefined,
        }));
  if (models.length) return models;

  const current = capabilities?.codexSettings?.model;
  if (current && current.toLowerCase().includes(query)) {
    return [{ label: current, value: current, description: "Current session setting", badge: "current" }];
  }

  return [];
}

function permissionArgOptions(
  query: string,
  capabilities: SessionCapabilities | null | undefined,
): SlashArgOption[] {
  const settings = capabilities?.codexSettings;
  const groups = [
    {
      key: "approval",
      current: settings?.approvalPolicy,
      values: ["never", "on-request", "on-failure", "untrusted"],
    },
    {
      key: "sandbox",
      current: settings?.sandboxMode,
      values: ["read-only", "workspace-write", "danger-full-access"],
    },
    {
      key: "reviewer",
      current: settings?.approvalsReviewer,
      values: ["user", "auto_review", "guardian_subagent"],
    },
  ];

  if (!query || !query.includes("=")) {
    return groups
      .map((group) => ({
        label: `${group.key}=`,
        value: `${group.key}=`,
        description: group.current ? `Current: ${group.current}` : "Choose a value",
      }))
      .filter((option) => option.label.toLowerCase().startsWith(query));
  }

  const [key, rawValue = ""] = query.split("=", 2);
  const group = groups.find((candidate) => candidate.key.startsWith(key));
  if (!group) return [];
  return group.values
    .filter((value) => value.includes(rawValue))
    .map((value) => ({
      label: `${group.key}=${value}`,
      value: `${group.key}=${value}`,
      description: group.current === value ? "Current session setting" : undefined,
      badge: group.current === value ? "current" : undefined,
    }));
}

function reasoningDescription(effort: string): string {
  switch (effort) {
    case "minimal":
      return "Fastest, lightest reasoning";
    case "low":
      return "Fast with some reasoning";
    case "medium":
      return "Balanced default";
    case "high":
      return "Deeper reasoning";
    case "xhigh":
      return "Maximum reasoning";
    default:
      return "";
  }
}

function slashCommandMatches(command: SlashCommandDefinition, query: string): boolean {
  return command.command.startsWith(query) || Boolean(command.aliases?.some((alias) => alias.startsWith(query)));
}

function getEntityQuery(value: string): { kind: "skill" | "mention"; query: string; token: string; start: number; end: number } | null {
  const match = value.match(/(^|\s)([$@][^\s]*)$/);
  if (!match || match.index === undefined) return null;
  const token = match[2];
  return {
    kind: token.startsWith("$") ? "skill" : "mention",
    query: token.slice(1).toLowerCase(),
    token,
    start: match.index + match[1].length,
    end: value.length,
  };
}

function getEntityOptions(
  capabilities: SessionCapabilities | null | undefined,
  kind: "skill" | "mention",
  query: string,
): EntityOption[] {
  if (kind === "skill") {
    return (capabilities?.skills ?? [])
      .filter((skill) => skill.name.toLowerCase().includes(query))
      .slice(0, 12)
      .map((skill) => ({
        type: "skill" as const,
        label: skill.name,
        description: skill.description,
        value: { name: skill.name, path: skill.path },
      }));
  }
  return (capabilities?.mentions ?? [])
    .filter((mention) => mention.name.toLowerCase().includes(query))
    .slice(0, 12)
    .map((mention) => ({
      type: "mention" as const,
      label: mention.name,
      description: mention.description,
      kind: mention.kind,
      value: { name: mention.name, path: mention.path },
    }));
}

function extractStructuredInputs(
  text: string,
  capabilities: SessionCapabilities | null | undefined,
): { skills: PromptSkillInput[]; mentions: PromptMentionInput[] } {
  const skills = (capabilities?.skills ?? [])
    .filter((skill) => containsToken(text, "$", skill.name))
    .map((skill) => ({ name: skill.name, path: skill.path }));
  const mentions = (capabilities?.mentions ?? [])
    .filter((mention) => containsToken(text, "@", mention.name))
    .map((mention) => ({ name: mention.name, path: mention.path }));
  return { skills, mentions };
}

function containsToken(text: string, prefix: "$" | "@", name: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegex(prefix + name)}(?=\\s|$)`).test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function supportColor(support: SlashCommandDefinition["support"]): string {
  switch (support) {
    case "local":
      return "var(--accent)";
    case "codex-app-server":
      return "var(--success)";
    case "recognized":
      return "var(--text-muted)";
  }
}
