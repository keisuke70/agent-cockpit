import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router";
import { useAuth } from "./hooks/useAuth.js";
import { Layout } from "./components/Layout.js";
import { HomePage } from "./pages/HomePage.js";
import { SessionPage } from "./pages/SessionPage.js";

export function App() {
  const { verified, checking, login } = useAuth();

  if (checking) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <span style={{ color: "var(--text-muted)" }}>Loading...</span>
      </div>
    );
  }

  if (!verified) {
    return <LoginScreen onLogin={login} />;
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

function LoginScreen({ onLogin }: { onLogin: (token: string) => Promise<boolean> }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await onLogin(input.trim());
    if (!ok) setError(true);
  }

  return (
    <div
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
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Agent Cockpit</h1>
      <p style={{ color: "var(--text-muted)", textAlign: "center" }}>
        Enter the auth token from the server console.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, width: "100%", maxWidth: 400 }}>
        <input
          type="password"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(false); }}
          placeholder="Auth token"
          style={{ flex: 1, minHeight: 44 }}
        />
        <button
          type="submit"
          style={{
            padding: "10px 20px",
            background: "var(--accent)",
            color: "white",
            borderRadius: "var(--radius-sm)",
            fontWeight: 600,
            minHeight: 44,
          }}
        >
          Login
        </button>
      </form>
      {error && <span style={{ color: "var(--danger)", fontSize: 14 }}>Invalid token</span>}
    </div>
  );
}
