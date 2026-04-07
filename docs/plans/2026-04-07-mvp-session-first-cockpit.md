# MVP: Session-First Web Cockpit

**作成日**: 2026-04-07
**ステータス**: Draft
**目的**: Mac mini 上の CLI エージェント（codex, claude）を Web UI からプロンプト駆動で操作する session-first cockpit の MVP

---

## 1. スコープ

### MVP に含めるもの

1. **Repo 登録**: 管理対象 repo のパスを登録・一覧・削除
2. **Agent 選択**: codex / claude を選択可能
3. **Session 管理**: 新規作成・一覧・再開・削除
4. **Prompt Composer**: Web 上の入力欄からプロンプト送信
5. **Streaming 出力**: WebSocket 経由でリアルタイム表示
6. **基本操作**: stop（プロセス kill）
7. **Mobile-first UI**: 下部固定 composer、片手操作しやすいレイアウト

### MVP に含めないもの

- IDE 代替機能（ファイルエディタ等）
- カンバン / タスクボード
- 複数エージェント同時実行の高度なオーケストレーション
- 認証・権限分離（Tailscale 内のみ前提）
- PWA オフライン機能
- retry / branch 確認などの高度操作

---

## 2. アーキテクチャ

### 技術スタック

| レイヤー | 技術 |
|---------|------|
| Monorepo | npm workspaces |
| Frontend | React 19 + Vite + TypeScript |
| Styling | Tailwind CSS 4 |
| Backend | Node.js + Express + TypeScript |
| リアルタイム通信 | WebSocket (ws) |
| プロセス管理 | node-pty |
| DB | better-sqlite3 |
| バリデーション | zod |

### ディレクトリ構成

```
agent-cockpit/
├── package.json              # workspace root
├── packages/
│   ├── shared/               # 共有型定義・zod スキーマ
│   │   ├── package.json
│   │   └── src/
│   │       ├── types.ts      # Session, Repo, Message 等の型
│   │       └── schemas.ts    # zod スキーマ
│   ├── server/               # バックエンド
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts      # エントリポイント
│   │       ├── db/
│   │       │   ├── schema.ts # SQLite テーブル定義
│   │       │   └── client.ts # DB 接続
│   │       ├── routes/
│   │       │   ├── repos.ts  # /api/repos
│   │       │   └── sessions.ts # /api/sessions
│   │       ├── ws/
│   │       │   └── handler.ts # WebSocket 接続管理
│   │       └── agent/
│   │           ├── spawner.ts # CLI 起動ロジック
│   │           └── registry.ts # エージェント定義
│   └── web/                  # フロントエンド
│       ├── package.json
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── components/
│           │   ├── Layout.tsx
│           │   ├── SessionList.tsx
│           │   ├── SessionView.tsx
│           │   ├── PromptComposer.tsx
│           │   ├── OutputStream.tsx
│           │   ├── RepoSelector.tsx
│           │   └── AgentSelector.tsx
│           ├── hooks/
│           │   ├── useWebSocket.ts
│           │   └── useSession.ts
│           └── lib/
│               └── api.ts
```

### データフロー

```
[Browser] --HTTP--> [Express API] --SQLite--> [DB]
[Browser] <--WS---> [WS Handler] <--PTY---> [CLI Process (codex/claude)]
```

1. ユーザーが Prompt Composer から送信
2. WebSocket 経由で server へ
3. server が node-pty で CLI プロセスを spawn
4. PTY の stdout を WebSocket 経由でブラウザへストリーミング
5. セッション・メッセージは SQLite に永続化

---

## 3. データモデル

### SQLite テーブル

```sql
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  agent TEXT NOT NULL CHECK(agent IN ('codex', 'claude')),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'stopped')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 4. API 設計

### REST API

| Method | Path | 説明 |
|--------|------|------|
| GET | /api/repos | Repo 一覧 |
| POST | /api/repos | Repo 登録 |
| DELETE | /api/repos/:id | Repo 削除 |
| GET | /api/sessions | Session 一覧（?repo_id フィルタ可） |
| POST | /api/sessions | Session 新規作成 |
| GET | /api/sessions/:id | Session 詳細 + メッセージ履歴 |
| DELETE | /api/sessions/:id | Session 削除 |

### WebSocket プロトコル

接続: `ws://host:port/ws/sessions/:id`

クライアント → サーバー:
```json
{ "type": "prompt", "content": "..." }
{ "type": "stop" }
```

サーバー → クライアント:
```json
{ "type": "output", "content": "..." }
{ "type": "status", "status": "running" | "idle" | "stopped" }
{ "type": "error", "message": "..." }
```

---

## 5. CLI 起動仕様

### Agent Registry

```typescript
const agents = {
  codex: {
    command: 'codex',       // PATH から解決
    args: (repoPath) => ['-C', repoPath, '--full-auto'],
    env: {},                // 必要に応じて PATH を明示
  },
  claude: {
    command: 'claude',
    args: (repoPath) => ['--directory', repoPath, '--dangerously-skip-permissions'],
    env: {},
  },
};
```

### PATH の扱い

- server 起動時に `codex` / `claude` の絶対パスを解決してキャッシュ
- 見つからない場合は起動時にワーニングを出すが、server 自体は起動する
- spawn 時に `PATH` を明示設定（launchd 対策）

---

## 6. フロントエンド画面仕様

### 画面構成（3 画面）

1. **Session List**: セッション一覧、新規作成ボタン
2. **Session View**: メッセージ履歴 + PromptComposer + OutputStream
3. **Settings**: Repo 登録・管理（モーダルまたは別画面）

### Session List

- カード形式でセッション一覧表示
- 各カードに: タイトル、agent アイコン、repo 名、最終更新日時、ステータス
- 上部に「新規セッション」ボタン → repo + agent 選択 → 作成
- ステータスでフィルタ（running / idle / all）

### Session View（メイン画面）

- **上部**: セッションタイトル、agent バッジ、repo 名、戻るボタン
- **中央**: メッセージ一覧（チャット風、user/assistant 区別）
  - assistant メッセージはストリーミング中アニメーション付き
  - コードブロックのシンタックスハイライトは後回し（MVP ではプレーンテキスト）
- **下部固定**: PromptComposer
  - textarea（auto-resize）
  - 送信ボタン（右端）
  - 実行中は Stop ボタンに切り替え
  - Enter で送信、Shift+Enter で改行

### 状態定義

各画面で以下の状態を仕様として定義:

| 状態 | Session List | Session View |
|------|-------------|-------------|
| Loading | スケルトン | スケルトン |
| Empty | 「セッションを作成しましょう」 | 「プロンプトを入力してください」 |
| Error | エラーバナー + リトライ | エラーバナー |
| Running | ステータスバッジ「実行中」 | Composer が Stop モード |

### Mobile 最適化

- viewport 全体を使う（100dvh）
- Composer は keyboard 表示時も画面内に留まる
- タッチターゲット 44px 以上
- スワイプでセッション一覧に戻る（後回し可）

---

## 7. 実装フェーズ

### Phase 1: プロジェクトスキャフォールド

- npm workspaces セットアップ
- TypeScript 設定
- ESLint + Prettier
- shared パッケージ（型定義・zod スキーマ）

### Phase 2: バックエンド

- Express サーバー + SQLite 初期化
- Repo CRUD API
- Session CRUD API
- WebSocket ハンドラ（接続・切断管理）
- node-pty による CLI spawn + ストリーミング

### Phase 3: フロントエンド

- Vite + React + Tailwind セットアップ
- React Router でルーティング
- Session List 画面
- Session View 画面（PromptComposer + OutputStream）
- Repo / Agent セレクター
- WebSocket hook

### Phase 4: 結合・動作確認

- フロントエンド → バックエンド結合
- Vite proxy 設定
- 基本的な E2E 動作確認
- dev 起動スクリプト（`npm run dev` で server + web 同時起動）

---

## 8. 非機能要件

- **データ保存先**: `~/.local/share/agent-cockpit/` (XDG 準拠、Linux/Mac 両対応)
  - macOS の `~/Library/Application Support/` も将来対応可能だが、MVP では XDG で統一
- **ポート**: server は `localhost:4800`（デフォルト）
- **ログ**: console に出力（MVP では十分）
- **セキュリティ**: localhost bind のみ、認証なし（Tailscale 前提）

---

## 9. リスクと対策

| リスク | 対策 |
|--------|------|
| node-pty がこの環境でビルドできない | prebuild-install を使う。ダメなら child_process.spawn にフォールバック |
| CLI の PATH が通らない | server 起動時に絶対パス解決、spawn 時に env.PATH を明示 |
| WebSocket 切断時のデータロス | メッセージは DB に即時書き込み、再接続時に履歴から復元 |
| モバイルキーボードで Composer が隠れる | visualViewport API で高さ調整 |
