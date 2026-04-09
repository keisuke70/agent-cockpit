# Phase 5: Mobile-first 体験を実体化する

## Context

Phase 1〜4 で「web 上で prompt を打って Claude/Codex がストリーミング応答する」という session-first MVP は完成した。しかし `docs/plans/2026-04-09-agi-cockpit-feature-gap.md` の調査で、現状の PWA は「シェルだけはモバイルでも動くが、実運用では結局 Mac を見に行かないとならない」状態だと明確になった。Phase 5 では、その差分を「mobile-first を掲げるなら不誠実」レベルの 4 項目に絞って一気に埋める。

選定基準:
- mobile-first 哲学を実体化する (notifications, swipe nav)
- session-first 哲学と矛盾しない
- それぞれが独立に shippable で、Phase 5 内で並列に進められる
- "薄いけど使える" を維持する。スコープ膨張を避ける

P0 の 4 項目:
1. **Web Push 通知** — turn 完了/error をスマホに飛ばす
2. **モバイル session スワイプナビ** — 隣の session に片手で移動 (single live のまま)
3. **Git context 表示** — session header に branch + dirty 表示
4. **launchd 常駐化** — 手動 `npx tsx` から脱却

---

## 1. Web Push 通知

### 目的
ターン完了/エラー時にスマホに OS-level 通知を飛ばし、画面に張り付かずに済むようにする。

### 設計

**サーバー側:**

- 新規依存: `web-push` (npm)
- VAPID キーペアを起動時に生成し `~/Library/Application Support/agent-cockpit/vapid.json` に保存 (token と同じパターン)
- 新規テーブル `push_subscriptions`:
  ```sql
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          TEXT PRIMARY KEY,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ```
  注意: subscription は端末に紐づく。session には紐づけず、有効な購読全件に配信する (single-user 想定なので簡単)
- 新規ルート `packages/server/src/routes/push.ts`:
  - `GET  /api/push/vapid-public-key` — フロントに公開鍵を返す
  - `POST /api/push/subscribe` — `{endpoint, keys: {p256dh, auth}}` を保存 (UNIQUE upsert)
  - `DELETE /api/push/subscribe` — `{endpoint}` で削除
- フック点: `packages/server/src/ws/session-bridge.ts` の **すべてのターン終端**:
  - `turn_complete` イベント (line 103-111) - 通常完了
  - `error` イベント (line 113-121) - エラー終了
  - **`close` イベント内の one-shot fallback path** (Codex の場合、`turn_complete` を出さずに `close` で終わるケース。session-bridge.ts の `attachProcessListeners` 内の close ハンドラ) - 同じ idle 遷移をしているのに通知が漏れることのないように、この経路にも配信フックを通す
  - つまり「セッションが running から idle/error/stopped に遷移する場所すべて」がフック点であり、共通の「ターン終端 helper」を session-bridge 内に作って 3 経路から呼ぶ形にする
- push 配信は async fire-and-forget で、個別の subscription 失敗 (410 Gone) は DB から削除
- 配信ヘルパー `packages/server/src/push.ts` を新設: `notifyAll(payload: {title, body, sessionId})`
- 既存パターンを踏襲: `getDb()` 直接、zod は不要 (subscription 構造は固定)

**フロント側:**

- vite-plugin-pwa を **`generateSW` のままにする**。`importScripts` で外部 push handler を読み込む方が、injectManifest に切り替えるより既存設定への影響が少ない
  - `vite.config.ts` の `workbox` に `importScripts: ["/push-sw.js"]` を追加
  - `packages/web/public/push-sw.js` を新規作成し `self.addEventListener('push', ...)` と `notificationclick` を実装
  - notificationclick で `clients.openWindow('/session/' + payload.sessionId)` を呼ぶ
- 新規 hook `packages/web/src/hooks/usePushSubscription.ts`:
  - 初回マウント時に Notification permission をチェック (非要求、表示のみ)
  - "Enable notifications" ボタンを HomePage 設定欄に置き、明示的なユーザーアクションで `Notification.requestPermission()` → `serviceWorker.ready.pushManager.subscribe(...)` → `POST /api/push/subscribe`
  - VAPID 公開鍵は `GET /api/push/vapid-public-key` で取得

**重要な制約:**

- iOS / iPadOS で Web Push が動くのは:
  - **iOS 16.4 以降** であり、かつ
  - **「ホーム画面に追加」した PWA として開いている** 場合のみ
  - 通常の Safari タブでは仕様上 Web Push はサポートされない (16.4+ でも同様)
  - したがってフロントの設定 UI は、`window.matchMedia('(display-mode: standalone)').matches === true` のときのみ「Enable notifications」ボタンを active にし、それ以外は disabled + "iOS は 16.4+ かつホーム画面追加が必要" の説明文を出す
- macOS Safari は site が PWA としてホーム画面追加されている必要あり (上と同様)
- Chrome / Edge は通常タブでも OK
- Android Chrome は通常タブでも OK

### 影響範囲ファイル
- `packages/server/src/db.ts` (テーブル追加)
- `packages/server/src/routes/push.ts` (新規)
- `packages/server/src/push.ts` (新規)
- `packages/server/src/ws/session-bridge.ts` (フック点 line 103/113 周辺)
- `packages/server/src/index.ts` (route 登録 + VAPID 初期化)
- `packages/server/package.json` (web-push 追加)
- `packages/web/vite.config.ts` (workbox.importScripts 追加)
- `packages/web/public/push-sw.js` (新規)
- `packages/web/src/hooks/usePushSubscription.ts` (新規)
- `packages/web/src/pages/HomePage.tsx` (設定 UI)

### 検証
1. Mac mini で `npm run dev` → Chrome デスクトップで通知許可 → Claude にプロンプト → 完了時に notification が出ることを確認
2. 同じことを iPhone (iOS 16.4+) Safari (PWA 追加状態) で確認
3. 無効な subscription を DB に手動で入れて、配信失敗時に DB から削除されることを確認

---

## 2. モバイル session スワイプナビ

### 目的
スマホで隣の session に片手で素早く移動できるようにする。**single live session のまま**であり、複数 live ではない。隣の session に到達した時点で旧 session の WS は切断され、新 session の WS が張られる。

### 設計

**ナビゲーション戦略 (調査結果に基づく):**

調査で 2 案あった:
- A) `useNavigate` で URL 更新 → React Router が SessionPage を再 mount
- B) SessionPage 内部に `currentSessionId` state を持ち、URL は遅延更新

**A を採用する**。理由:
- B は StreamOutput の scroll jank 対策には良いが、useWebSocket の cleanup ロジックが既に綺麗で、再 mount のコストは無視できる
- B の "URL を遅延更新" は backbutton や履歴の整合性を壊しやすい
- A であれば既存の useWebSocket / useSession の依存配列がそのまま動く
- スワイプ完了時に瞬間的な flash が出ても、それは "遷移" の natural な表現

**実装:**

- 新規 hook `packages/web/src/hooks/useSwipeNavigation.ts`:
  - touchstart/touchmove/touchend を扱う
  - 水平方向の delta が縦方向より大きく、かつ閾値 (50px) を超えた場合のみ swipe と判定
  - 既存の縦スクロール (StreamOutput の overflow-y) と競合しないよう、`touchmove` で `Math.abs(dx) > Math.abs(dy)` の時だけ `preventDefault`
- SessionPage に `useSwipeNavigation` を組み込む。スワイプハンドラーで:
  - 同じ repo の sessions を `/api/sessions?repoId=<rid>` で取得 (`useSession` で current session の repoId が分かる)
  - `updated_at desc` の順序で current session の prev/next を割り出し、`navigate(\`/session/${nextId}\`)` を呼ぶ
- 端 (最初/最後) ではスワイプを無視 (rubber-band 等の凝った演出はしない)
- ヘッダーに `< 2/5 >` のような位置インジケータを表示 (任意, スコープ圧迫したらカット)

**SessionPage の load 順:**

現状は session 詳細を `useSession` で取得しているが、swipe nav のためには「同じ repo の session 一覧」も必要。これは新規 hook `useRepoSessions(repoId)` で取得する。session 詳細が来てから siblings を取得する 2 段ロードでよい (体感に影響しない)。

### 影響範囲ファイル
- `packages/web/src/hooks/useSwipeNavigation.ts` (新規)
- `packages/web/src/hooks/useRepoSessions.ts` (新規)
- `packages/web/src/pages/SessionPage.tsx` (swipe handler 組み込み, position indicator)

### 検証
1. デスクトップ Chrome の DevTools で touch emulation を有効にしてスワイプ確認
2. 実機 (iPhone) で repo に 3+ sessions ある状態で確認
3. 縦スクロール中に水平スワイプが誤発火しないことを確認
4. 端でのスワイプが無視されることを確認

---

## 3. Git context 表示

### 目的
session header に「いまどのブランチで、変更があるか」が見えるようにする。Claude が `git checkout` した時の検知や、自分が手で何か触った時の状況把握に使う。

### 設計

**サーバー側:**

- 新規ヘルパー `packages/server/src/git.ts`:
  - `getGitStatus(repoPath: string): Promise<GitStatus | null>` を export
  - 内部で 3 つを並列実行 (Promise.all, 各 5 秒タイムアウト):
    - `git rev-parse --abbrev-ref HEAD` → `branch`
    - `git status --porcelain` → 各行が "tracked changes" or "untracked" を表す。**ここから `dirty` フラグと `filesChanged` を導出する**。具体的には行数 = 変更があった path 数 (untracked を含む)
    - `git diff --shortstat HEAD` → tracked かつ committed file の差分行数。出力例: ` 3 files changed, 12 insertions(+), 5 deletions(-)`。このコマンドは untracked file をカウントしないので、insertions/deletions は **tracked のみの参考値**
  - `dirty = porcelain output が空でない`、`filesChanged = porcelain の行数` (これが UI のソース・オブ・トゥルース)
  - `insertions / deletions` は `git diff --shortstat` の数値だが、**該当する変更がない場合 (untracked のみのとき) は 0** になる
  - 失敗時 (リポジトリでない / git 未インストール) は null を返す
  - `makeSpawnEnv()` を `adapters/base.ts` から再利用
- `GitStatus` 型を `packages/shared/src/types.ts` に追加:
  ```typescript
  export interface GitStatus {
    branch: string;
    dirty: boolean;
    filesChanged: number;     // porcelain 行数 (untracked 含む) = ground truth
    insertions: number;       // diff --shortstat (tracked のみ)
    deletions: number;        // diff --shortstat (tracked のみ)
  }
  ```

**バッジ表示ルール (フロント側):**

- `!dirty` → `main` (clean、追加表示なし)
- `dirty && insertions+deletions > 0` → `main · +12/-3 (3 files)`
- `dirty && insertions+deletions === 0` (untracked のみ) → `main · ${filesChanged} new` (例: `main · 2 new`)
- どのケースでも `filesChanged` を ground truth として使う
- 新規ルート `packages/server/src/routes/repos.ts` に追加: `GET /api/repos/:id/git-status` → 上の helper を呼ぶ
- キャッシュは入れない (git 自体が高速で、5 秒 polling 程度なら問題ない)

**フロント側:**

- 新規 hook `packages/web/src/hooks/useGitStatus.ts`:
  - `repoId` を受け取って 5 秒間隔で `/api/repos/:id/git-status` を polling
  - `turn_complete` イベントが来たら追加で 1 回フェッチ (event hook は SessionPage から渡す)
- SessionPage header に `branch · dirty` 表示用の小さな badge を追加
  - cleanly: `main · clean`, dirty: `main · +12/-3`, dirty で files >0: `main · +12/-3 (3 files)`

**Race と Tearing:**

git status は session の cwd を見るのではなく **repo path** を見る。session の cwd が repo の subdirectory でも branch は同じだから問題ない。

### 影響範囲ファイル
- `packages/server/src/git.ts` (新規)
- `packages/shared/src/types.ts` (GitStatus 型追加)
- `packages/server/src/routes/repos.ts` (新規ルート追加)
- `packages/web/src/hooks/useGitStatus.ts` (新規)
- `packages/web/src/pages/SessionPage.tsx` (header に badge)

### 検証
1. 既存 repo を session で開き、`main · clean` が出ることを確認
2. ターミナルでファイルを編集 → 5 秒以内に `main · +X/-Y` に変わることを確認
3. Claude にファイル編集をさせて、turn_complete 直後に状態が更新されることを確認
4. リポジトリでない path を repo に登録した時、表示が出ない (= null) ことを確認

---

## 4. launchd 常駐化

### 目的
手動 `npx tsx packages/server/src/index.ts` を卒業し、Mac 起動時から自動で agent-cockpit が動いている状態にする。これは scheduling や push 通知が「常時飛んでくる」前提条件。

### 設計

**配布物:**

- 新規ファイル `scripts/com.kei.agent-cockpit.plist` (template):
  - `RunAtLoad = true`
  - `KeepAlive = true`
  - `WorkingDirectory = /Users/kei/projects/agent-cockpit`
  - `ProgramArguments = [/opt/homebrew/bin/node, /Users/kei/projects/agent-cockpit/packages/server/dist/index.js]`
  - `EnvironmentVariables.PATH = /Users/kei/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`
  - `StandardOutPath = /Users/kei/Library/Logs/agent-cockpit/launchd.out.log`
  - `StandardErrorPath = /Users/kei/Library/Logs/agent-cockpit/launchd.err.log`
- 新規スクリプト `scripts/install-launchd.sh`:
  - **`mkdir -p ~/Library/Logs/agent-cockpit`** を最初に実行 (launchd は `StandardOutPath` の親ディレクトリを自動作成しない)
  - サーバー側を build (`npm run build -w @agent-cockpit/shared -w @agent-cockpit/server -w @agent-cockpit/web`)
  - plist を `~/Library/LaunchAgents/com.kei.agent-cockpit.plist` にコピー
  - `launchctl unload` (既存があれば) → `launchctl load`
  - 状況を `launchctl list | grep agent-cockpit` で確認
- 新規スクリプト `scripts/uninstall-launchd.sh`: 逆操作

**重要な制約:**

- launchd の PATH は空。plist で明示する (上の `EnvironmentVariables.PATH`)
- `dist/index.js` を使うので Phase 5 着手時には server の `npm run build` が壊れていないか確認 (現状 tsc はパスする)
- token は `~/Library/Application Support/agent-cockpit/auth-token` から読まれるので、初回のみ手動起動して token を確認、その後 launchd に渡す
- Auth token は変えない (token file が永続化されている)

**README 更新:**

- 「常駐運用したい場合」セクションを追加し、`bash scripts/install-launchd.sh` を案内
- token の確認方法 (`cat ~/Library/Application\ Support/agent-cockpit/auth-token`)

### 影響範囲ファイル
- `scripts/com.kei.agent-cockpit.plist` (新規)
- `scripts/install-launchd.sh` (新規)
- `scripts/uninstall-launchd.sh` (新規)
- `README.md` (常駐運用節を追加)
- 注意: server コードへの変更は **ない** (dist/index.js を使うだけ)

### 検証
1. `bash scripts/install-launchd.sh` を実行
2. `launchctl list | grep agent-cockpit` で稼働中を確認
3. `curl http://127.0.0.1:3001/api/health` で `{"ok":true}`
4. Mac を再起動して、起動後すぐに `curl ...` が通ることを確認
5. ログが `~/Library/Logs/agent-cockpit/launchd.{out,err}.log` に出ることを確認

---

## 全体の実装順序

並列に進められるが、推奨される単一の commit 順序:

1. **Git context** (一番リスクが小さく、後続のテストの体験を良くする)
2. **Web Push** (バックエンド + フロント両方触るので独立 commit)
3. **Swipe nav** (フロントだけ、完成を体感しやすい)
4. **launchd** (server build が安定してから)

各項目は別 commit にする。3 ファイル以上変更が見込まれるので、各 commit の前に `/codex-impl-review` を回す。

---

## 検証 (Phase 5 全体)

Phase 5 完了時の E2E:

1. `bash scripts/install-launchd.sh` で常駐起動
2. iPhone PWA で開く → 通知許可 → 設定で push 有効化
3. session を開いて Claude にプロンプト → スマホ画面を閉じる
4. ターン完了時に通知が飛ぶ → 通知タップで該当 session を開く
5. session header に branch 状態が出ている
6. 別 session が同じ repo にある状態で左右スワイプして移動できる

---

## スコープ外 (Phase 6 以降)

ロードマップ (`docs/plans/2026-04-09-agi-cockpit-feature-gap.md`) に従い、以下は Phase 5 に **入れない**:

- 真の並列ライブビュー (複数 WS 同時)
- Gemini adapter
- Git Worktree 管理
- スケジューリング (cron / interval)
- Kanban 状態フィルタ
- 埋め込みターミナル (xterm.js)
- マスターエージェント (恒久的に却下)
