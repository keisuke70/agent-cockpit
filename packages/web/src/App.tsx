import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router";
import type { AuthError } from "./hooks/useAuth.js";
import { useAuth } from "./hooks/useAuth.js";
import { Layout } from "./components/Layout.js";
import { HomePage } from "./pages/HomePage.js";
import { SessionPage } from "./pages/SessionPage.js";

export function App() {
  const { token, verified, checking, authError, login, retry } = useAuth();

  if (checking) {
    return (
      <main style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </main>
    );
  }

  if (!verified && token && authError?.type === "unreachable") {
    return <ConnectionScreen error={authError} onRetry={retry} />;
  }

  if (!verified) {
    return <LoginScreen authError={authError} onLogin={login} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="session/:id" element={<SessionPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function LoginScreen({
  authError,
  onLogin,
}: {
  authError: AuthError | null;
  onLogin: (token: string) => Promise<boolean>;
}) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmedInput = input.trim();
  const errorId = "auth-error";
  const hintId = "auth-token-hint";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmedInput || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(trimmedInput);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 24,
        gap: 16,
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Pocket Agent</h1>
      <p id={hintId} style={{ color: "var(--text-muted)", textAlign: "center" }}>
        Enter the auth token from the server console.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, width: "100%", maxWidth: 400 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor="auth-token" style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 6 }}>
            Auth token
          </label>
          <input
            id="auth-token"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste token"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={authError ? `${hintId} ${errorId}` : hintId}
            aria-invalid={authError?.type === "unauthorized"}
            style={{ width: "100%", minHeight: 44 }}
          />
        </div>
        <button
          type="submit"
          disabled={!trimmedInput || submitting}
          style={{
            alignSelf: "flex-end",
            padding: "10px 20px",
            background: trimmedInput && !submitting ? "var(--accent)" : "var(--bg-surface)",
            color: trimmedInput && !submitting ? "white" : "var(--text-muted)",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            minHeight: 44,
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Checking..." : "Login"}
        </button>
      </form>
      {authError && (
        <p
          id={errorId}
          role="alert"
          style={{ color: authError.type === "unauthorized" ? "var(--danger)" : "var(--text-muted)", fontSize: 14, textAlign: "center", maxWidth: 400, margin: 0 }}
        >
          {authError.message}
        </p>
      )}
    </main>
  );
}

function ConnectionScreen({ error, onRetry }: { error: AuthError; onRetry: () => void }) {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 24,
        gap: 16,
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Pocket Agent</h1>
      <p role="status" style={{ color: "var(--text-muted)", maxWidth: 420, margin: 0 }}>
        {error.message}
      </p>
      <p style={{ color: "var(--text-muted)", fontSize: 13, maxWidth: 420, margin: 0 }}>
        Your saved token was kept. This can happen while switching VPNs or while Tailscale reconnects.
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: "10px 20px",
          background: "var(--accent)",
          color: "white",
          borderRadius: "var(--radius-sm)",
          fontWeight: 600,
          minHeight: 44,
        }}
      >
        Retry connection
      </button>
    </main>
  );
}
