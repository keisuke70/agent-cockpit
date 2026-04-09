import { useEffect, useState } from "react";
import type { Session } from "@agent-cockpit/shared";
import { authHeaders } from "./useAuth.js";

export function useRepoSessions(repoId: string | null | undefined) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    if (!repoId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions?repoId=${repoId}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (!cancelled) setSessions(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  return sessions;
}
