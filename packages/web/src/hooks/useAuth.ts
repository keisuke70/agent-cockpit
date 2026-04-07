import { useState, useEffect, useCallback } from "react";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("cockpit-token"),
  );
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(true);

  const verify = useCallback(async (t: string) => {
    try {
      const res = await fetch("/api/repos", {
        headers: { Authorization: `Bearer ${t}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    verify(token).then((ok) => {
      setVerified(ok);
      setChecking(false);
      if (!ok) {
        localStorage.removeItem("cockpit-token");
        setToken(null);
      }
    });
  }, [token, verify]);

  const login = useCallback(
    async (t: string) => {
      const ok = await verify(t);
      if (ok) {
        localStorage.setItem("cockpit-token", t);
        setToken(t);
        setVerified(true);
      }
      return ok;
    },
    [verify],
  );

  return { token, verified, checking, login };
}

/** Get auth headers for fetch calls */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("cockpit-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
