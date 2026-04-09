import { useEffect, useState, useCallback, useRef } from "react";
import type { GitStatus } from "@agent-cockpit/shared";
import { authHeaders } from "./useAuth.js";

const POLL_INTERVAL_MS = 5000;

export function useGitStatus(repoId: string | null | undefined) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!repoId) return;
    try {
      const res = await fetch(`/api/repos/${repoId}/git-status`, {
        headers: authHeaders(),
      });
      if (!res.ok) {
        setStatus(null);
        return;
      }
      const data = await res.json();
      if (data && typeof data.branch === "string") {
        setStatus(data as GitStatus);
      } else {
        setStatus(null);
      }
    } catch {
      setStatus(null);
    }
  }, [repoId]);

  useEffect(() => {
    if (!repoId) {
      setStatus(null);
      return;
    }
    fetchStatus();
    timerRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [repoId, fetchStatus]);

  return { status, refresh: fetchStatus };
}
