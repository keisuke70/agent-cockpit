import { useState, useEffect, useCallback } from "react";
import { authHeaders } from "./useAuth.js";

export type PushState =
  | "unsupported"
  | "ios-needs-pwa"
  | "denied"
  | "default"
  | "subscribed";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

function detectInitialState(): PushState {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (isIos() && !isStandalone()) return "ios-needs-pwa";
    return "unsupported";
  }
  if (isIos() && !isStandalone()) return "ios-needs-pwa";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted") return "default"; // need to check sub
  return "default";
}

export function usePushSubscription() {
  const [state, setState] = useState<PushState>(() => detectInitialState());
  const [busy, setBusy] = useState(false);

  // On mount, if granted, check if we already have an active sub
  useEffect(() => {
    if (state !== "default" || Notification.permission !== "granted") return;
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (cancelled) return;
        if (sub) setState("subscribed");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state]);

  const enable = useCallback(async () => {
    if (state === "unsupported" || state === "ios-needs-pwa") return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "default");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch("/api/push/vapid-public-key", {
        headers: authHeaders(),
      });
      if (!keyRes.ok) throw new Error("Failed to fetch VAPID key");
      const { publicKey } = await keyRes.json();

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const json = sub.toJSON();
      const persistRes = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
        }),
      });
      if (!persistRes.ok) {
        // Server rejected — undo the browser subscription so local + server stay in sync
        await sub.unsubscribe().catch(() => {});
        setState("default");
        return;
      }
      setState("subscribed");
    } finally {
      setBusy(false);
    }
  }, [state]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const res = await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (!res.ok) {
          // Keep state subscribed so the user can retry
          return;
        }
        await sub.unsubscribe();
      }
      setState("default");
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, enable, disable };
}
