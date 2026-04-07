import { useState, useEffect } from "react";
import type { Session } from "@agent-cockpit/shared";
import { authHeaders } from "./useAuth.js";

export function useSession(sessionId: string) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    fetch(`/api/sessions/${sessionId}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then(setSession)
      .catch(() => {});
  }, [sessionId]);

  return session;
}
