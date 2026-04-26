import { useState, useEffect, useCallback } from "react";

type VerifyResult = "ok" | "unauthorized" | "unreachable";

export type AuthError =
  | { type: "unauthorized"; message: string }
  | { type: "unreachable"; message: string };

export function useAuth() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("cockpit-token"),
  );
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [checkNonce, setCheckNonce] = useState(0);

  const verify = useCallback(async (t: string): Promise<VerifyResult> => {
    try {
      const res = await fetch("/api/repos", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) return "ok";
      if (res.status === 401 || res.status === 403) return "unauthorized";
      return "unreachable";
    } catch {
      return "unreachable";
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setVerified(false);
      setChecking(false);
      return () => {
        cancelled = true;
      };
    }

    setChecking(true);
    setAuthError(null);
    verify(token).then((result) => {
      if (cancelled) return;
      setChecking(false);
      if (result === "ok") {
        setVerified(true);
        return;
      }

      setVerified(false);
      if (result === "unauthorized") {
        localStorage.removeItem("cockpit-token");
        setToken(null);
        setAuthError({
          type: "unauthorized",
          message: "Saved token was rejected. Enter the current auth token from the server console.",
        });
        return;
      }

      // Network failures, VPN/Tailscale interruptions, and temporary server
      // errors must not erase a known token. Keep it and let the user retry.
      setAuthError({
        type: "unreachable",
        message: "Could not reach Agent Cockpit. Check Tailscale/VPN connectivity and retry.",
      });
    });

    return () => {
      cancelled = true;
    };
  }, [token, verify, checkNonce]);

  const login = useCallback(
    async (t: string) => {
      setAuthError(null);
      const result = await verify(t);
      if (result === "ok") {
        localStorage.setItem("cockpit-token", t);
        setToken(t);
        setVerified(true);
        return true;
      }
      if (result === "unauthorized") {
        setAuthError({
          type: "unauthorized",
          message: "Invalid token. Paste the current auth token from the server console.",
        });
      } else {
        setAuthError({
          type: "unreachable",
          message: "Could not reach Agent Cockpit. Check Tailscale/VPN connectivity and retry.",
        });
      }
      return false;
    },
    [verify],
  );

  const retry = useCallback(() => {
    setCheckNonce((nonce) => nonce + 1);
  }, []);

  return { token, verified, checking, authError, login, retry };
}

/** Get auth headers for fetch calls */
export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("cockpit-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
