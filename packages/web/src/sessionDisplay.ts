import type { Session } from "@agent-cockpit/shared";

export function sessionDisplayName(
  session: Pick<Session, "id" | "name"> | Pick<Session, "name"> | null | undefined,
) {
  const name = session?.name?.trim();
  if (name) return name;

  const id = session && "id" in session ? session.id : null;
  return id ? `Session ${id.slice(0, 8)}` : "Untitled session";
}

export function sessionTimestampLabel(value: string | null | undefined) {
  if (!value) return "Not updated yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not updated yet";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function sessionAccessibleLabel(
  session: Pick<Session, "id" | "name" | "agent" | "updatedAt">,
  repoName?: string,
) {
  const repoPart = repoName?.trim() ? `, ${repoName.trim()}` : "";
  return `${sessionDisplayName(session)}${repoPart}, ${session.agent}, updated ${sessionTimestampLabel(session.updatedAt)}`;
}
