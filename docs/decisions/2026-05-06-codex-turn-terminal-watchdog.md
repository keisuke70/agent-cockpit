# Codex turn terminal watchdog

- Date: 2026-05-06
- Status: Accepted

## Context

Codex app-server is the authoritative owner of turn lifecycle, but Cockpit used to depend primarily on live `turn/completed` notifications to leave `running`. If that terminal notification was missed during a browser reconnect, launchd restart, or app-server event dispatch race, the UI could stay `running` with no visible response until a later reload reconciled the session as stopped/idle. In that window, the local Cockpit prompt and the materialized Codex transcript could diverge.

## Decision

After Cockpit receives or observes a Codex turn id for a submitted prompt, it starts a lightweight watchdog that periodically reads the app-server thread while the local turn is still running. If the Codex turn becomes terminal, Cockpit completes/stops/fails the matching local turn and refreshes the display transcript even if the live terminal notification never arrived. If the thread becomes idle before the accepted turn appears in the transcript, Cockpit marks the local turn as retryable desynchronization instead of leaving it running indefinitely.

## Consequences

- A missed `turn/completed` notification no longer leaves the mobile/PWA UI stuck in `running` until manual reload.
- Terminal reconciliation refreshes transcript output, so assistant messages that arrived while the WebSocket was disconnected become visible.
- Accepted-but-unmaterialized turns are surfaced as explicit retryable desyncs rather than silently becoming a stale stopped turn.
