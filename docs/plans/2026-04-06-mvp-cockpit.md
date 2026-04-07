# agent-cockpit MVP 実装プラン

## Context

Mac mini 上で動く CLI エージェント (claude v2.1.92, codex v0.118.0) に対して、スマホの web ブラウザから prompt を打って開発できる操作面を作る。現状はリポジトリに README と CLAUDE.md のみがあり、実装コードはゼロ。

### CLI の programmatic 能力（調査済み）

**Claude CLI**: `--print --output-format stream-json` で JSONL ストリーミング出力。`--input-format stream-json` で stdin から JSON メッセージを書き込むことで multi-turn 対話が可能。`--session-id <uuid>` でセッション管理。

**Codex CLI**: `codex exec` で non-interactive 実行。`--json` で構造化出力。exec は one-shot なので prompt ごとに新プロセスを spawn する。

---

## 1. リポジトリ構成 (npm workspaces)

```
agent-cockpit/
  package.json              # workspace root
  tsconfig.base.json
  packages/
    shared/                 # @agent-cockpit/shared
      src/
        types.ts            # 共有型定義
        schemas.ts          # zod スキーマ
        protocol.ts         # WebSocket メッセージ型
    server/                 # @agent-cockpit/server
      src/
        index.ts            # Fastify HTTP + WS server
        db.ts               # SQLite setup + migration
        routes/
          repos.ts
          sessions.ts
        adapters/
          base.ts           # CLI adapter interface
          claude.ts          # Claude CLI adapter
          codex.ts          # Codex CLI adapter
        ws/
          handler.ts        # WebSocket connection handler
          session-bridge.ts # WS <-> CLI process bridge
        process-manager.ts  # running child process tracking
    web/                    # @agent-cockpit/web
      src/
        main.tsx
        App.tsx
        hooks/
          useWebSocket.ts
          useSession.ts
        components/
          SessionList.tsx
          SessionDetail.tsx
          Composer.tsx
          StreamOutput.tsx
          RepoAgentSelector.tsx
          Layout.tsx
        pages/
          HomePage.tsx
          SessionPage.tsx
```

## 2. データモデル (SQLite)

DB ファイル: `~/Library/Application Support/agent-cockpit/cockpit.db`

```sql
CREATE TABLE repos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id),
  agent           TEXT NOT NULL,        -- 'claude' | 'codex'
  cli_session_id  TEXT,                 -- CLI 側の session ID
  cwd             TEXT,                 -- per-session working directory (null = repo root)
  name            TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',  -- idle | running | stopped | error
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,   -- 1-based sequence within session
  status      TEXT NOT NULL DEFAULT 'running', -- running | complete | error | stopped
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  cost_usd    REAL,
  metadata    TEXT,               -- JSON blob for adapter-specific data
  UNIQUE(session_id, seq)
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  turn_id     TEXT REFERENCES turns(id),
  role        TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 3. サーバーアーキテクチャ

- **Fastify** + `@fastify/websocket` + `@fastify/cors` + `@fastify/static`
- **better-sqlite3** (同期 SQLite、single-user アプリに十分)
- **nanoid** (ID 生成)

### REST API
- `GET/POST /api/repos`, `DELETE /api/repos/:id`
- `GET/POST /api/sessions`, `GET /api/sessions/:id`
- `GET /api/sessions/:id/messages`

### WebSocket
- エンドポイント: `ws://host:port/ws?sessionId=xxx`

#### 接続・再接続プロトコル
1. 接続時、サーバーは `{ type: 'snapshot', messages: Message[], lastSeq: number, status: string }` を送信
2. 全サーバー→クライアントイベントにはインクリメンタルな `seq` (sequence number) を付与
3. 再接続時、クライアントは `ws://host:port/ws?sessionId=xxx&lastSeq=42` で接続
4. サーバーは `lastSeq` 以降のイベントを再送（バッファは直近 turn のみ保持）
5. バッファ範囲外の場合は full snapshot にフォールバック

#### メッセージ型
- クライアント→サーバー: `send_prompt`, `stop`, `retry`
- サーバー→クライアント: `snapshot`, `text_delta`, `message_complete`, `turn_complete`, `error`, `status`（全て `seq` 付き）

## 4. CLI Adapter 設計

### Turn-oriented インターフェース

Claude (persistent process) と Codex (one-shot) の違いを吸収するため、
process lifecycle ではなく turn lifecycle を抽象化する。

```typescript
interface CLIAdapter {
  /** セッション開始 or 再開。persistent adapter は長期プロセスを返す */
  init(opts: { cwd: string; cliSessionId?: string }): Promise<AdapterHandle>;

  /** 新しい turn を開始。one-shot adapter は新プロセスを spawn する */
  startTurn(handle: AdapterHandle, prompt: string): void;

  /** 実行中の turn を停止 */
  stopTurn(handle: AdapterHandle): void;

  /** セッション全体を終了 */
  dispose(handle: AdapterHandle): void;

  /** stdout の 1 行を正規化イベントに変換 */
  parseEvent(line: string): NormalizedEvent | null;
}

/** adapter が管理する内部状態。adapter ごとに拡張する */
interface AdapterHandle {
  proc: ChildProcess | null;
  cliSessionId?: string;
}
```

Claude adapter: `init()` で長期プロセスを spawn し、`startTurn()` は stdin に書き込み。
Codex adapter: `init()` は handle だけ返し、`startTurn()` で毎回 `codex exec` を spawn。

### NormalizedEvent（ブラウザに送る正規化イベント、全イベントに seq 付与）
```typescript
type NormalizedEvent =
  | { type: 'init'; sessionId: string; seq: number }
  | { type: 'text_delta'; text: string; seq: number }
  | { type: 'message_complete'; content: string; role: 'assistant'; seq: number }
  | { type: 'tool_use'; tool: string; input: unknown; seq: number }
  | { type: 'turn_complete'; cost?: number; seq: number }
  | { type: 'error'; message: string; seq: number }
  | { type: 'status'; status: 'running' | 'stopped' | 'idle'; seq: number }
```

### Claude adapter
- 1セッション = 1 長期プロセス (`--input-format stream-json` で stdin に書き込み)
- spawn: `claude --print --output-format stream-json --input-format stream-json --session-id <uuid>`
- 追加 prompt: stdin に `{"type":"user","content":"..."}` を書き込み
- resume: `--resume <session-id>` で既存セッション再開

### Codex adapter
- 1 prompt = 1 `codex exec` プロセス (one-shot)
- spawn: `codex exec --json -C <repo-path> --full-auto <prompt>`
- stop: SIGTERM

### PATH 注意
spawn 時に明示的に PATH を設定:
```typescript
const env = {
  ...process.env,
  PATH: `/Users/kei/.local/bin:/opt/homebrew/bin:${process.env.PATH}`,
};
```

## 5. フロントエンド設計

- **React 19** + **react-router v7**
- **Vite** + `@vitejs/plugin-react` + `vite-plugin-pwa`
- 状態管理: `useState` + `useRef` + custom hooks（ライブラリ不要）
- Markdown レンダリング: `react-markdown`

### 画面構成

**Home (/)** — セッション一覧
- 上部: repo ドロップダウン + agent トグル
- セッションリスト (updated_at desc)
- 新規セッション作成ボタン

**Session (/session/:id)** — セッション詳細
- ヘッダー: 戻る、セッション名、agent badge、status
- スクロール領域: チャット形式のメッセージ表示
- 下部固定 Composer: textarea (auto-grow) + 送信/停止ボタン

### Mobile-first CSS
- Composer: `position: sticky; bottom: 0` + `safe-area-inset-bottom`
- タップターゲット: 最低 44px
- auto-scroll: 新メッセージで自動スクロール

## 6. 依存パッケージ（全量）

| Package | Where | Purpose |
|---------|-------|---------|
| `typescript` | root dev | 型チェック |
| `zod` | shared | validation |
| `fastify` | server | HTTP server |
| `@fastify/websocket` | server | WebSocket |
| `@fastify/cors` | server | CORS (dev) |
| `@fastify/static` | server | 静的ファイル配信 |
| `better-sqlite3` | server | SQLite |
| `nanoid` | server | ID 生成 |
| `tsx` | server dev | TS 直接実行 |
| `react` | web | UI |
| `react-dom` | web | UI |
| `react-router` | web | routing |
| `react-markdown` | web | MD 表示 |
| `vite` | web dev | bundler |
| `@vitejs/plugin-react` | web dev | React plugin |
| `vite-plugin-pwa` | web dev | PWA |
| `@types/react` | web dev | React 型定義 |
| `@types/react-dom` | web dev | ReactDOM 型定義 |
| `@types/node` | root dev | Node.js 型定義 |
| `@types/better-sqlite3` | server dev | SQLite 型定義 |
| `concurrently` | root dev | server + web 同時起動 (`npm run dev`) |

計 21 パッケージ（runtime 14 + dev 7）。意図的に最小限。

### dev scripts (root package.json)
- `dev`: `concurrently "npm run dev -w @agent-cockpit/server" "npm run dev -w @agent-cockpit/web"`
- `build`: 各 workspace の build を順次実行
- `typecheck`: `tsc --build` (project references)

## 7. 実装フェーズ

### Phase 1: Skeleton + Claude streaming + 基盤設計
- workspace root + 3 packages の初期化
- shared 型定義（NormalizedEvent with seq, WS protocol, turn model）
- server: Fastify + SQLite (repos, sessions, turns, messages) + repo CRUD
- Turn-oriented adapter interface + Claude adapter (spawn, JSONL parse, stdin write)
- WebSocket handler + session-bridge（snapshot, seq-based reconnect contract）
- 検証: wscat から prompt 送信 → ストリーミング出力確認 → 再接続で catch-up 確認

### Phase 2: Frontend + session flow
- Vite + React セットアップ
- HomePage: セッション一覧 (API 連携)
- SessionPage: Composer + StreamOutput
- useWebSocket hook
- E2E 検証: スマホから prompt 入力 → Claude がストリーミング応答

### Phase 3: Full CRUD + Codex + polish
- Repo 管理 UI
- Session create/resume フロー
- Codex adapter
- Agent selector UI
- Stop/retry コントロール
- PWA manifest + service worker
- Mobile CSS 調整

### Phase 4: Resilience
- WebSocket 再接続 (exponential backoff)
- プロセス cleanup (SIGTERM handler)
- エラー状態 UI
- Session resume (`--resume`)
- ログ出力 (`~/Library/Logs/agent-cockpit/`)

## 8. 検証方法

1. `npm run dev` でサーバー + フロントエンド起動
2. ブラウザで `http://localhost:3000` を開く
3. repo を追加 → session を作成 → prompt を送信
4. Claude からのストリーミング出力がリアルタイムで表示されることを確認
5. 停止ボタンでプロセスが kill されることを確認
6. session 一覧に戻り、再度開いて履歴が表示されることを確認
7. Tailscale 経由でスマホからアクセスし、mobile UI を確認

## 9. 設計判断の要点

- **Claude は長期プロセス、Codex は one-shot**: Claude の `--input-format stream-json` により 1 プロセスで multi-turn 可能。Codex exec は 1 prompt = 1 プロセス。
- **Fastify over Express**: 新規プロジェクトでは TypeScript サポートと速度で Fastify が優位。
- **better-sqlite3 (同期)**: single-user アプリに async SQLite は過剰。WAL mode で十分。
- **ORM なし**: テーブル 4 つ (repos, sessions, turns, messages)。生 SQL が最もシンプル。
- **状態管理ライブラリなし**: ページ 2 つ、WS 接続 1 つ。React built-in で十分。
