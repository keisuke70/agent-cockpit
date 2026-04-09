import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import webpush from "web-push";
import { getDb } from "./db.js";

const DATA_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "agent-cockpit",
);
const VAPID_FILE = join(DATA_DIR, "vapid.json");
const SUBJECT = "mailto:agent-cockpit@localhost";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

function loadOrCreateVapidKeys(): VapidKeys {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(VAPID_FILE)) {
    return JSON.parse(readFileSync(VAPID_FILE, "utf8"));
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

let _publicKey: string | null = null;

export function initPush(): { publicKey: string } {
  const keys = loadOrCreateVapidKeys();
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  _publicKey = keys.publicKey;
  return { publicKey: keys.publicKey };
}

export function getPublicKey(): string {
  if (!_publicKey) throw new Error("Push not initialized");
  return _publicKey;
}

export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function addSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}) {
  const db = getDb();
  // Upsert: if endpoint exists, update keys
  const existing = db
    .prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?")
    .get(sub.endpoint) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE push_subscriptions SET p256dh = ?, auth = ?, enabled = 1 WHERE id = ?",
    ).run(sub.keys.p256dh, sub.keys.auth, existing.id);
    return existing.id;
  }
  const id = nanoid();
  db.prepare(
    "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
  ).run(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  return id;
}

export function removeSubscription(endpoint: string) {
  const db = getDb();
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

/**
 * Fire-and-forget broadcast to all enabled subscriptions.
 * Subscriptions that return 404/410 are auto-removed.
 */
export function notifyAll(payload: PushPayload) {
  const db = getDb();
  const subs = db
    .prepare(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE enabled = 1",
    )
    .all() as SubscriptionRow[];

  for (const sub of subs) {
    webpush
      .sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload),
        { TTL: 60 },
      )
      .catch((err: any) => {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription expired/invalid - remove it
          db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
        }
        // Other errors are silently dropped (logged via Fastify if reachable)
      });
  }
}
