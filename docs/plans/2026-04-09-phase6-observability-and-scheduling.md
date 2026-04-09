# Phase 6: 観察性と自動化 (並列ライブ + Scheduling + Terminal + Filters)

## Context

Phase 5 で mobile-first 体験 (Push 通知 / スワイプ / Git context / launchd) を埋めた。ロードマップ (`docs/plans/2026-04-09-agi-cockpit-feature-gap.md`) に従えば次は P1 グループで、残っていたのは:

1. 真の複数セッション並列ライブビュー
2. Gemini adapter
3. Git Worktree / workspace 管理
4. スケジューリング (cron / interval)
5. 状態フィルタとしての session list 拡張
6. 埋め込みターミナル (xterm.js secondary mode) — P2
7. 複数 repo 横断ビュー — P2

ユーザーとの直近会話で **2 (Gemini)** と **3 (Worktree)** を恒久却下した。理由:

- **Gemini**: ユーザーが gemini CLI を使っていない。需要なし
- **Worktree**: ユーザーは並列で agent を回す時も worktree を使っていない。フォルダ散乱・依存重複・切替コストの方が高く、想定する事故 (同じファイルの同時編集) が実運用ではほぼ発生しない

このプランは:
- ロードマップ文書の Worktree / Gemini を P3 (恒久却下) に移動する
- 残った 5 項目 (1, 4, 5, 6, 7) を Phase 6 として一括実装する

5 項目はそれぞれ独立に shippable。ただし「並列ライブビュー」は実装方針を 1 つ確定させてからでないと膨らみやすいので、まずそこを決める。

---

## 並列ライブビューの方針: Lobby WebSocket

ロードマップの初期文言は「複数 session を同時に WS 接続して live で観察」だった。これを素直に実装すると、フロントで session ごとに `useWebSocket` を呼んで N 本の WS を維持することになる。これは:

- 接続数 / メモリ / 電池のコストが大きい
- 各 session の `eventBuffer` を listener が抱えるので server 側もスケールしない
- そもそも UI で全 session を同時に「読む」ことはなく、欲しいのは「どの session が今 running か / さっき完了したか」を一望すること

なので採用方針は **Lobby WebSocket**:

- 新規エンドポイント `/ws/lobby` を 1 本追加
- このエンドポイントは **「全セッションの状態遷移」だけを broadcast** する。message preview や transcript fan-out は Phase 6 のスコープに含めない (やるなら別フェーズで個別 WS を開く方が筋がいい)
- 1 本の WS で全セッションのライブ状態を知れる
- 個別 session の詳細ストリームは従来通り `/ws?sessionId=...` で取る (排他ではなく、追加で開く形)
- HomePage / SessionList がこの lobby に接続して、行ごとの `status` ドットや「Running...」ラベルをリアルタイム更新

これは「真の並列ライブビュー」の実用的な薄い版。N 本接続のフルバージョンは P3 に永久後退させる (UX 的にも技術的にも meaningful な benefit がない)。

---

## 5 つの実装項目

### 1. 状態フィルタ (session list)

**目的**: 「running な session だけ見たい」「error になった session を探したい」を 1 タップで。

**実装**:
- `packages/web/src/pages/HomePage.tsx` に status タブ (chip 群) を追加
- フィルタ候補: `all` / `running` / `idle` / `error` (`stopped` は `idle` に統合してもよいが、明示する方が分かりやすいので別)
- `RepoAgentSelector.tsx` の toggle button パターンを再利用
- **Lobby (項目 4) との連携が必須**。フィルタは fetch した `session.status` をそのまま使うのではなく、`liveStatuses` map (lobby から来る最新状態) で上書きした **effectiveStatus** を導出してから filter する:
  ```typescript
  const effectiveStatus = (s: Session) => liveStatuses.get(s.id) ?? s.status;
  const filtered = sessions.filter(s => filter === 'all' || effectiveStatus(s) === filter);
  ```
- これをやらないと「いま running な session を絞り込みたい」が refetch まで反映されず、Phase 6 のメイン目的が壊れる
- effectiveStatus は SessionList の row 表示にも同じ map を使う

**影響範囲**: `packages/web/src/pages/HomePage.tsx` のみ。ただし項目 4 (Lobby) の commit より後に取り込む必要がある

---

### 2. 横断ビュー (cross-repo session list)

**目的**: 「最近触った session を repo 横断で一覧」。

**実装**:
- サーバー側は **何もしない**。`GET /api/sessions` (repoId なし) は既に全 repo を返す (`packages/server/src/routes/sessions.ts:7-25`)
- HomePage の RepoAgentSelector に `All Repos` 選択肢を追加
- selectedRepoId が "(all)" のとき、`fetchSessions` は repoId なしで叩く
- SessionList の各行に repo 名を表示する必要がある。現状は表示していないので、`RepoAgentSelector` から repo 一覧を取って `repoId -> name` map を作って渡す

**影響範囲**:
- `packages/web/src/pages/HomePage.tsx` (selector + fetch 分岐)
- `packages/web/src/components/SessionList.tsx` (repo 名表示)
- `packages/web/src/components/RepoAgentSelector.tsx` (All Repos 選択肢)

---

### 3. 埋め込みターミナル (debug view)

**目的**: chat ビューの裏で、agent CLI の生 stdout を確認したい。**範囲は agent プロセスの生 stdio を覗く debug view まで**。一般 CLI タスクは対象外。

**実装方針**: xterm.js は **使わない**。理由:
- Claude/Codex の `--output-format stream-json` / `--json` は ANSI を含まない JSONL
- xterm は 200KB あり、bundle が肥える
- 単方向 read-only の表示なら `<pre>` + monospace で十分

**サーバー側**:
- `RawStdoutEvent` を `packages/shared/src/protocol.ts` の `ServerEvent` union に追加:
  ```typescript
  interface RawStdoutEvent {
    type: "raw_stdout";
    data: string;  // raw chunk as utf-8 string
    seq: number;
  }
  ```
- `packages/server/src/ws/session-bridge.ts` の `attachProcessListeners` で、`stdout.on("data", chunk)` の冒頭で `broadcastEvent(managed, { type: "raw_stdout", data: chunk.toString(), seq })` を発行
- `packages/server/src/process-manager.ts` の `broadcastEvent` を変更し、**`raw_stdout` イベントは eventBuffer に積まない** (catch-up 対象外、reconnect 時は失われてよい)。理由は raw stdout が高頻度で 500 件 buffer を瞬殺するから
- **明示的な reconnect セマンティクス**: Debug モードは **non-replayable / live-only** であり、reconnect すると再接続前の raw bytes は失われる。Chat の transcript は messages テーブルに永続化されているので reconnect で復元できるが、Debug ビューはそうではない。これは意図的な設計判断であり、ドキュメントにも明記する

**フロント側**:
- `packages/web/src/pages/SessionPage.tsx` のヘッダに `Chat / Debug` トグルを追加
- `Debug` モードのとき StreamOutput の代わりに `<TerminalView />` を表示
- `TerminalView` は `<pre>` で raw_stdout の data を append。auto-scroll は StreamOutput と同じパターン
- `useWebSocket` に `rawStdout` 状態を追加し、`raw_stdout` イベントが来たら `setRawStdout(prev => prev + event.data)` する。**メモリ膨張対策**: 64KB を超えたら先頭を切り詰める

**影響範囲**:
- `packages/shared/src/protocol.ts` (RawStdoutEvent 追加)
- `packages/server/src/ws/session-bridge.ts` (raw broadcast)
- `packages/server/src/process-manager.ts` (broadcastEvent の buffer 除外)
- `packages/web/src/hooks/useWebSocket.ts` (rawStdout state + 切り詰め)
- `packages/web/src/components/TerminalView.tsx` (新規)
- `packages/web/src/pages/SessionPage.tsx` (toggle + 表示分岐)

---

### 4. 並列ライブ (Lobby WebSocket)

**目的**: HomePage / SessionList で全 session のライブ状態を一望する。新 turn が走り始めたり完了したりしたのが、リロードなしに反映される。

**サーバー側**:
- `packages/server/src/process-manager.ts` に **lobby listeners** の集合を追加:
  ```typescript
  type LobbyEvent =
    | { type: "session_status"; sessionId: string; status: SessionStatus }
    | { type: "session_updated"; sessionId: string; updatedAt: string };

  const lobbyListeners = new Set<(event: LobbyEvent) => void>();
  export function addLobbyListener(fn: ...) { ... }
  export function removeLobbyListener(fn: ...) { ... }
  export function broadcastLobby(event: LobbyEvent) { ... }
  ```
- `packages/server/src/ws/session-bridge.ts` の各状態遷移点 (`updateSessionStatus(sessionId, X)` の呼び出し直後) で `broadcastLobby({ type: "session_status", sessionId, status: X })` を発行
- 新規ハンドラ `packages/server/src/ws/lobby-handler.ts` を作成し、`/ws/lobby` で websocket 接続を受ける。接続時に `addLobbyListener`、close で `removeLobbyListener`
- 認証は既存の `onRequest` フックで自動的に通る (auth hook は `/ws` プレフィックスで判定する。現在は `url.startsWith("/ws")` なので `/ws/lobby` も通る)

**フロント側**:
- 新規 hook `packages/web/src/hooks/useLobby.ts`:
  - `/ws/lobby?token=...` に接続
  - `Map<sessionId, status>` を返す
  - 既存 useWebSocket と同じ reconnect / cleanup パターンを踏襲 (intentional close + exponential backoff)
- HomePage で `useLobby` を呼んで、そのマップを SessionList に渡す
- SessionList の status ドットは props の `liveStatuses` を優先し、無ければ `session.status` を使う

**影響範囲**:
- `packages/server/src/process-manager.ts` (lobby listeners)
- `packages/server/src/ws/session-bridge.ts` (broadcastLobby 呼び出し)
- `packages/server/src/ws/lobby-handler.ts` (新規)
- `packages/server/src/index.ts` (lobby route 登録)
- `packages/web/src/hooks/useLobby.ts` (新規)
- `packages/web/src/pages/HomePage.tsx` (useLobby を呼んで SessionList に渡す)
- `packages/web/src/components/SessionList.tsx` (liveStatuses を受け取って優先)

**想定リスク**:
- lobby は全 session の状態変化を受け取るので、頻繁に更新される。スロットリング不要 (status 変化は秒単位)
- listener と per-session listener は別集合なので、既存 WS フローには影響しない

---

### 5. スケジューリング (cron-only)

**目的**: 「この session に毎朝 9 時にこの prompt を流す」。

**Phase 6 のスコープ縮小**:
- **cron 式のみ** をサポート。interval (`every N minutes`) は文字通り `*/N * * * *` cron で表現できるので別モデルにしない。元のロードマップ文言は "cron / interval" だが Phase 6 では cron に統一する
- **In-memory single-process scheduler のみ**。サーバープロセスが生きている間しか fire しない。launchd 常駐を前提にしている (Phase 5 で済)
- **Missed run の catch-up は行わない**。サーバーがダウン中に予定時刻を過ぎても再実行しない
- **Multi-process は対象外**。複数の agent-cockpit インスタンスを同時に走らせると schedule が二重 fire するので、`launchctl list` 上 1 インスタンスである前提
- **Pre-approval は省略**。本プロジェクトは single-user trusted 環境なので、cron expr の妥当性検証 (`cron.validate`) のみで保存を許可する。意図的なスコープ縮小であり、もし将来 multi-user / untrusted 想定を取り入れるなら明示的に承認フローを追加する

**サーバー側**:
- 新規依存: `node-cron`
- DB に新規テーブル `schedules`:
  ```sql
  CREATE TABLE IF NOT EXISTS schedules (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    prompt      TEXT NOT NULL,
    cron_expr   TEXT NOT NULL,           -- node-cron 形式 (5 フィールド)
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    TEXT,                    -- last fire ISO datetime
    last_status TEXT,                    -- 'fired' | 'skipped_running' | 'error'
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```
- 新規モジュール `packages/server/src/scheduler.ts`:
  - 起動時に DB から enabled な schedules を全件読み込み、各々を `cron.schedule(expr, handler)` で登録
  - handler は `ensureManaged(sessionId)` → `sendPrompt(...)` を呼ぶ
  - 対象 session が既に running なら skip して `last_status = 'skipped_running'`
  - エラー時は `last_status = 'error'`、成功時は `last_status = 'fired'`、いずれも `last_run` を更新
  - schedule の追加/削除/有効化/無効化を CRUD で扱うため `addSchedule(id) / removeSchedule(id) / refreshSchedule(id)` を export
- 新規ルート `packages/server/src/routes/schedules.ts`:
  - `GET    /api/sessions/:id/schedules`
  - `POST   /api/sessions/:id/schedules` body: `{ prompt, cronExpr }`
  - `DELETE /api/schedules/:id`
  - `PATCH  /api/schedules/:id` body: `{ enabled }`
  - 各 mutate ルートは scheduler の add/remove/refresh を呼ぶ
- `index.ts` で `initScheduler()` を `getDb()` の後・route 登録の前に呼ぶ。`pushRoutes` と同じ要領で `scheduleRoutes` を登録

**フロント側**:
- 新規 hook `packages/web/src/hooks/useSchedules.ts`: session の schedules 取得 + 追加 + 削除 + toggle
- SessionPage に `Schedules` パネル (折り畳み式)。session header 直下にトグルボタン、開くと:
  - 既存 schedule のリスト: cron expr / prompt の先頭 60 文字 / enabled toggle / delete button / last run timestamp
  - 「Add schedule」ボタンで cron expr (preset: `0 9 * * *` (毎朝 9 時) / `0 * * * *` (毎時) / custom) と prompt を入力
- mobile-first を維持するため、フォームは縦並び minimal

**安全装置**:
- 任意 cron expr を受け付けるが、サーバー側で `cron.validate(expr)` で検証してから保存
- 1 session に複数 schedule 可
- ユーザーが手動で session を開いている間に schedule が fire しても、走るのは同じ adapter / cli session なので副作用は最小

**影響範囲**:
- `packages/server/package.json` (node-cron + @types/node-cron)
- `packages/server/src/db.ts` (schedules テーブル)
- `packages/server/src/scheduler.ts` (新規)
- `packages/server/src/routes/schedules.ts` (新規)
- `packages/server/src/index.ts` (init + route 登録)
- `packages/shared/src/types.ts` (Schedule 型)
- `packages/web/src/hooks/useSchedules.ts` (新規)
- `packages/web/src/components/SchedulePanel.tsx` (新規)
- `packages/web/src/pages/SessionPage.tsx` (panel toggle)

---

## 並列実装可能性

各項目は独立に shippable。推奨 commit 順 (リスクと依存):

1. **Status filter** (一番小さい、UI のみ)
2. **Cross-repo view** (UI のみ、SessionList の repo 名表示が前提)
3. **Embedded terminal** (protocol 拡張あり、コアフローへの影響は局所的)
4. **Lobby WS** (新 WS 経路、既存フローに影響しない)
5. **Scheduling** (一番大きい、新規依存あり)

各 commit の前に `/codex-impl-review` を回す。3 ファイル以上は確実に超えるので 5 commit 全部レビュー対象。

---

## ロードマップ更新 (`docs/plans/2026-04-09-agi-cockpit-feature-gap.md`)

このプランの実装と同時に、ロードマップ文書も更新する:

- **Worktree** を P1 から P3 (恒久却下) に移動
  - 理由: 並列 agent 実行で実際の事故が発生していない / フォルダ散乱のコストが高い
- **Gemini adapter** を P1 から P3 (恒久却下) に移動
  - 理由: ユーザーが gemini CLI を使っていない
- **真の複数セッション並列ライブビュー** を P1 から **Phase 6 (Lobby 版)** に移動。N 本接続のフルバージョンは P3 永久後退
- **Phase 5 (実装済み)** の節を追記
- **Phase 6 として実装中** の節を追記

これは Phase 6 実装の **最初の commit** に含めて、以後の commit が roadmap と同期した状態を維持する。

---

## 検証 (Phase 6 全体)

実装後に以下を E2E で確認:

1. HomePage で `running` フィルタを選ぶと、走っている session だけが残る
2. `All Repos` を選ぶと、全 repo の session が updated_at desc で並ぶ。各行に repo 名が表示される
3. SessionPage で `Debug` トグルを押すと、ターミナル風の `<pre>` ビューに切り替わり、Claude の生 JSONL がストリームで流れる
4. Session A で prompt を流しつつ、別タブで HomePage を開く → A の行が `running` に変わり、完了すると `idle` に戻る (lobby が動いている証拠)
5. Session B に schedule を追加 (`*/2 * * * *` で 2 分ごと) → 2 分待つと自動で prompt が流れて turn が完了する
6. 同 schedule が走っている最中にもう 1 回 fire する場合 → skip され `last_status = 'skipped_running'` になる

---

## スコープ外 (恒久的に Phase 6 でやらないこと)

- 真の N 本同時 WS 接続 (Lobby 版で十分)
- xterm.js (debug `<pre>` で十分)
- Worktree (恒久却下)
- Gemini adapter (恒久却下)
- マスターエージェント (Claude Code 側に移譲)
