import { useEffect, useState, useCallback } from "react";
import type { Schedule } from "@agent-cockpit/shared";
import { authHeaders } from "./useAuth.js";

export function useSchedules(sessionId: string | null | undefined) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSchedules = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/schedules`, {
        headers: authHeaders(),
      });
      if (res.ok) setSchedules(await res.json());
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  const create = useCallback(
    async (prompt: string, cronExpr: string) => {
      if (!sessionId) return null;
      const res = await fetch(`/api/sessions/${sessionId}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ prompt, cronExpr }),
      });
      if (!res.ok) return null;
      await fetchSchedules();
      return (await res.json()) as Schedule;
    },
    [sessionId, fetchSchedules],
  );

  const remove = useCallback(
    async (scheduleId: string) => {
      const res = await fetch(`/api/schedules/${scheduleId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) await fetchSchedules();
    },
    [fetchSchedules],
  );

  const toggle = useCallback(
    async (scheduleId: string, enabled: boolean) => {
      const res = await fetch(`/api/schedules/${scheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) await fetchSchedules();
    },
    [fetchSchedules],
  );

  return { schedules, loading, create, remove, toggle, refresh: fetchSchedules };
}
