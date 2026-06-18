export type SlashCommandCategory =
  | "workflow"
  | "session"
  | "configuration"
  | "information"
  | "integration"
  | "ui"
  | "debug";

export type SlashCommandSupport =
  | "local"
  | "codex-app-server"
  | "recognized";

export interface SlashCommandDefinition {
  command: string;
  description: string;
  aliases?: string[];
  category: SlashCommandCategory;
  support: SlashCommandSupport;
  supportsInlineArgs?: boolean;
}

// Mirrors Codex CLI's built-in slash-command catalog, with Pocket Agent-only
// aliases kept next to the native command they map to.
export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    command: "/help",
    description: "Show supported Pocket Agent and native Codex slash commands.",
    aliases: ["/h"],
    category: "information",
    support: "local",
  },
  {
    command: "/model",
    description: "Choose what model and reasoning effort to use.",
    aliases: ["/models"],
    category: "configuration",
    support: "local",
  },
  {
    command: "/provider",
    description: "Choose the model provider.",
    category: "configuration",
    support: "recognized",
  },
  {
    command: "/reasoning",
    description: "Choose reasoning effort.",
    aliases: ["/reason"],
    category: "configuration",
    support: "local",
  },
  {
    command: "/fast",
    description: "Toggle Fast mode for fastest inference with increased plan usage.",
    category: "configuration",
    support: "recognized",
    supportsInlineArgs: true,
  },
  {
    command: "/ide",
    description: "Include current selection, open files, and other context from your IDE.",
    category: "ui",
    support: "recognized",
    supportsInlineArgs: true,
  },
  {
    command: "/permissions",
    description: "Show current Pocket Agent permission and sandbox settings.",
    aliases: ["/approval", "/approvals"],
    category: "configuration",
    support: "local",
  },
  {
    command: "/keymap",
    description: "Remap TUI shortcuts.",
    category: "ui",
    support: "recognized",
    supportsInlineArgs: true,
  },
  {
    command: "/vim",
    description: "Toggle Vim mode for the composer.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/setup-default-sandbox",
    description: "Set up elevated agent sandbox.",
    category: "configuration",
    support: "recognized",
  },
  {
    command: "/sandbox-add-read-dir",
    description: "Let sandbox read a directory: /sandbox-add-read-dir <absolute_path>.",
    category: "configuration",
    support: "recognized",
    supportsInlineArgs: true,
  },
  {
    command: "/experimental",
    description: "List experimental features visible to Codex.",
    category: "configuration",
    support: "local",
  },
  {
    command: "/approve",
    description: "Approve one retry of a recent auto-review denial.",
    category: "workflow",
    support: "recognized",
  },
  {
    command: "/memories",
    description: "Configure memory use and generation.",
    category: "configuration",
    support: "recognized",
  },
  {
    command: "/skills",
    description: "List skills Codex can use for specific tasks.",
    aliases: ["/use"],
    category: "integration",
    support: "local",
  },
  {
    command: "/hooks",
    description: "View lifecycle hooks configured for Codex.",
    category: "integration",
    support: "local",
  },
  {
    command: "/review",
    description: "Review current changes and find issues.",
    aliases: ["/r"],
    category: "workflow",
    support: "codex-app-server",
    supportsInlineArgs: true,
  },
  {
    command: "/rename",
    description: "Rename the current thread.",
    category: "session",
    support: "local",
    supportsInlineArgs: true,
  },
  {
    command: "/new",
    description: "Create a clean Pocket Agent session in the same repo.",
    category: "session",
    support: "local",
    supportsInlineArgs: true,
  },
  {
    command: "/resume",
    description: "Browse and open saved Pocket Agent sessions.",
    category: "session",
    support: "local",
    supportsInlineArgs: true,
  },
  {
    command: "/sessions",
    description: "Browse saved Pocket Agent sessions.",
    aliases: ["/history"],
    category: "session",
    support: "local",
  },
  {
    command: "/fork",
    description: "Fork the current chat.",
    category: "session",
    support: "codex-app-server",
  },
  {
    command: "/init",
    description: "Create an AGENTS.md file with instructions for Codex.",
    category: "workflow",
    support: "recognized",
  },
  {
    command: "/compact",
    description: "Summarize conversation to prevent hitting the context limit.",
    category: "session",
    support: "codex-app-server",
  },
  {
    command: "/undo",
    description: "Undo the latest turn.",
    category: "session",
    support: "codex-app-server",
  },
  {
    command: "/plan",
    description: "Switch to Plan mode.",
    category: "workflow",
    support: "codex-app-server",
    supportsInlineArgs: true,
  },
  {
    command: "/goal",
    description: "Set or view the goal for a long-running task.",
    category: "workflow",
    support: "codex-app-server",
    supportsInlineArgs: true,
  },
  {
    command: "/collab",
    description: "Change collaboration mode (experimental).",
    category: "workflow",
    support: "recognized",
  },
  {
    command: "/agent",
    description: "Switch the active agent thread.",
    aliases: ["/subagents"],
    category: "workflow",
    support: "recognized",
  },
  {
    command: "/side",
    description: "Start a side conversation in an ephemeral fork.",
    category: "workflow",
    support: "recognized",
    supportsInlineArgs: true,
  },
  {
    command: "/copy",
    description: "Show the last assistant response as copyable markdown.",
    category: "ui",
    support: "local",
  },
  {
    command: "/diff",
    description: "Show git diff summary, including untracked files.",
    category: "information",
    support: "local",
  },
  {
    command: "/mention",
    description: "Mention a file.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/status",
    description: "Show current session configuration and token usage.",
    aliases: ["/s"],
    category: "information",
    support: "local",
  },
  {
    command: "/debug-config",
    description: "Show config layers and requirement sources for debugging.",
    category: "debug",
    support: "local",
  },
  {
    command: "/title",
    description: "Configure which items appear in the terminal title.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/statusline",
    description: "Configure which items appear in the status line.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/theme",
    description: "Choose a syntax highlighting theme.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/mcp",
    description: "List configured MCP tools; use /mcp verbose for details.",
    category: "integration",
    support: "local",
    supportsInlineArgs: true,
  },
  {
    command: "/apps",
    description: "Manage apps.",
    category: "integration",
    support: "local",
  },
  {
    command: "/plugins",
    description: "Browse plugins.",
    category: "integration",
    support: "local",
  },
  {
    command: "/logout",
    description: "Log out of Codex.",
    category: "configuration",
    support: "recognized",
  },
  {
    command: "/quit",
    description: "Exit Codex.",
    category: "session",
    support: "recognized",
  },
  {
    command: "/exit",
    description: "Exit Codex.",
    category: "session",
    support: "recognized",
  },
  {
    command: "/feedback",
    description: "Send logs to maintainers.",
    category: "ui",
    support: "recognized",
  },
  {
    command: "/ps",
    description: "List background terminals.",
    category: "information",
    support: "recognized",
  },
  {
    command: "/stop",
    description: "Stop all background terminals.",
    aliases: ["/clean"],
    category: "workflow",
    support: "codex-app-server",
  },
  {
    command: "/clear",
    description: "Create a clean Pocket Agent session in the same repo.",
    aliases: ["/c"],
    category: "session",
    support: "local",
    supportsInlineArgs: true,
  },
  {
    command: "/personality",
    description: "Choose a communication style for Codex.",
    category: "configuration",
    support: "recognized",
  },
];

export function findSlashCommandDefinition(
  commandOrAlias: string,
): SlashCommandDefinition | undefined {
  const normalized = commandOrAlias.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!normalized?.startsWith("/")) return undefined;
  return SLASH_COMMANDS.find(
    (command) =>
      command.command === normalized || command.aliases?.includes(normalized),
  );
}
