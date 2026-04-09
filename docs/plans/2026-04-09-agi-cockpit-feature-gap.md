# AGI Cockpit との機能差分とサイドプラン

## Context

このリポジトリは元々 [AGI Cockpit](https://agilab.tools/cockpit/) を見て「自分は AGI ラボの月額メンバーシップに継続的に入る気はない」と判断したことから、自作の代替を作る方針で始まった。Phase 1〜4 で session-first の薄い MVP は完成したが、現時点では AGI Cockpit が公にうたっている機能セットを意図的に絞ったため、何を取り入れて何を捨てるかを改めて整理しておきたい。

このプランは「実装プラン」ではなく「ロードマップとしての中長期サイドプラン」。
- 各項目を P0〜P3 の優先度で並べ、後続の Phase で実装プランを別途立てるための根拠資料にする
- Phase 5 で着手する候補と、Phase 6 以降に温存する候補を明示する
- AGI Cockpit が「正しい設計」とは限らないので、本リポジトリの session-first 哲学と矛盾するものは積極的に却下する

---

## AGI Cockpit の機能（公開情報からの集約）

**ソース**:
- 公式 LP: https://agilab.tools/cockpit/
- AGI ラボ note (v1.5 / v3.0): https://chatgpt-lab.com/n/nf178a3d39e1d , https://chatgpt-lab.com/n/nd2e5ef201888
- AGI Inc 概要: https://www.theagi.company/
- X 告知 (v1.5 リモート対応): @ytiskw / @kai_postv 投稿

### コア機能

1. **マルチエージェント対応**: Claude Code / Codex CLI / Gemini CLI を 1 つの GUI から並列実行
2. **マスターエージェント (v2.0+)**: Claude Code 自身を「指揮役」にして、`./task` 経由でサブエージェントを自律的に decompose / monitor / integrate
3. **Kanban 風タスクボード**: active / pending review / completed の 3 列。複数の AI タスクを一望
4. **スケジューリング**: cron / interval / one-time の自動実行（朝のコードレビュー、デプロイなど）
5. **セッション再開**: 中断ワークフローからの resume
6. **Git 連携**: ブランチ表示、変更差分のリアルタイム可視化
7. **埋め込みターミナル (xterm.js)**: 実行ログ、対話履歴
8. **通知**: agent ステータス変化（review pending / completion）の自動通知
9. **PWA リモートアクセス (v1.5+)**: スマホからタスク監視・指示
10. **強固な VPN セキュリティ**: いわゆる「次世代 VPN」(Tailscale 系) を前提
11. **スワイプでタスク切替**: スマホでの並列タスク間ナビゲーション
12. **自動アップデート**: `versions.json` API による version 同期
13. **対象 OS**: macOS Apple Silicon のみ（Windows 検討中）
14. **配布**: AGI ラボ会員向け（メンバーシップ前提）

### v1.5 → v3.0 の進化軌跡

- v1.5: PWA リモートアクセス対応
- v2.0: マスターエージェント導入（自律的タスク分解）
- v3.0.2: 現行版

---

## 現状 (agent-cockpit Phase 1〜4) との差分

### 部分的に実装済み (Phase 1〜4 でカバーした範囲)

完全な「同等以上」とは言えない。実装の強い部分と弱い部分を率直に分けて記録する。

**完全に近い:**

| AGI Cockpit 機能 | agent-cockpit 状況 |
|---|---|
| Claude 実行 (multi-turn, streaming) | ✅ 長期プロセス + stream-json で完全対応 |
| Codex 実行 (one-shot exec per turn) | ✅ exec adapter 実装済み |
| ストリーミング出力 | ✅ WebSocket + seq-based reconnect |
| 認証 | ✅ token-based auth (single-user) |
| PWA シェル | ✅ vite-plugin-pwa, manifest, service worker |
| Tailscale 経由のリモート公開モデル | ✅ 127.0.0.1 bind + README に Tailscale Serve 手順 |

**部分的:**

| AGI Cockpit 機能 | agent-cockpit 状況 |
|---|---|
| セッション再開 | ⚠️ Claude のみ `--resume` で対応 (`packages/server/src/adapters/claude.ts`)。Codex は one-shot で「再開」概念がそもそも cli にない (`packages/server/src/adapters/codex.ts`) |
| モバイル運用 | ⚠️ PWA 化はしたが、通知・スワイプ・並列セッション操作などスマホ実利用に必要なものはまだ不足 |
| Mac mini 常駐 | ⚠️ localhost bind + Tailscale までは整備したが、launchd plist による daemon 化は未着手。手動 `npx tsx` 起動が前提 |

### ❌ AGI Cockpit にあって agent-cockpit にない機能

| 機能 | 評価 | 理由 |
|---|---|---|
| **Push 通知** | 取り入れる | mobile-first の核心。turn 完了時に通知が飛ばないと結局画面に張り付く必要がある |
| **スワイプでセッション切替** | 取り入れる | mobile-first を掲げているなら必須級。並列ライブビューと切り離し、「ナビゲーションだけ」を先に入れる |
| **Git context 表示** | 取り入れる | session header に branch + dirty 状態を出すだけで価値が大きい |
| **Git Worktree / workspace 管理** | 取り入れる | README で「Repo / Working Directory」をコア概念と宣言しているのに、現状 `cwd` カラムがあるだけで worktree ライフサイクルは無い。並列セッションを安全に走らせるための session-first 基盤として筋が良い |
| **Gemini adapter** | 取り入れる | adapter 1 個の追加で済む。ただし mobile-first ではないので優先度は中。Gemini CLI 未インストールなのでまず環境整備から |
| **複数セッション並列ライブビュー** | 取り入れる | 現状は 1 セッション 1 画面。複数 session を同時に live で観察できると体験が大きく変わる。ただし WS 接続数・メモリ・電池の影響が大きく、独立したフェーズで設計が必要 |
| **スケジューリング (cron / interval)** | 取り入れる | README の「拡張候補」にも明記されている。harness 側に CronCreate などの兆候もある |
| **Kanban 風タスクボード** | 部分的に取り入れる | フル kanban は session-first 哲学に反するが、「running / waiting / done」の状態フィルタとしての session list 拡張なら筋が良い |
| **マスターエージェント** | 却下 | "薄いけど使える MVP" を明示的に優先する哲学に反する。Claude Code 自体が orchestration を内包しつつあるので車輪の再発明になる |
| **埋め込みターミナル (xterm.js)** | 条件付き取り入れ | "secondary terminal mode" として toggle 可能にする。chat ビューを主、terminal を escape hatch にする。**ただし「agent ではない一般 CLI タスクの実行面」までは引き受けない** — それは mosh / 既存ターミナル側の責務として残す |
| **自動アップデート** | 却下 | 自作 OSS で配布形態が tarball / git pull 想定なので不要 |
| **versions.json API** | 却下 | 上に同じ |

---

## 設計判断の要点

1. **session-first を曲げない**: AGI Cockpit は v2.0 以降「task 中心 / kanban 中心」に振っているが、本プロジェクトの README で繰り返し session / prompt / output が主役と宣言している。task board は二次機能のままにする
2. **自作哲学**: master agent のような「魔法のオーケストレーション」は維持コストが高い。Claude Code 側が同等機能を内包する流れもあるので、本プロジェクトはあくまで操作面に集中する
3. **OSS / 単一ユーザー前提**: 配布や monetization 機能は持たない。AGI Cockpit が会員制で吸収しているコスト（パッケージング、サポート）を徹底的に削る
4. **mobile-first を実体化**: 通知 + スワイプ + 並列ビューは「mobile-first を掲げる以上、入っていないと嘘になる」レベル。AGI Cockpit の v1.5 がここに踏み込んだのは正しい判断であり、本プロジェクトもここは追従する

---

## 優先度付き機能ロードマップ

### P0: 次の Phase 5 で着手

選定基準: 「mobile-first を掲げるなら入っていないと不誠実」かつ「Phase 5 内で独立に shippable」。

1. **Push 通知 (Web Push)**
   - 対象: turn 完了 / error / status 変化
   - サーバー: VAPID 鍵生成 + subscription 保存
   - フロント: Service Worker 経由で notification 表示
   - 技術リスク: PWA Web Push は iOS Safari 16.4+ が必要。Android Chrome は問題なし

2. **モバイル session スワイプナビゲーション (ナビゲーションだけ)**
   - 対象: スマホで「ひとつだけ live なセッション」を左右スワイプで隣の session に切り替え
   - 実装: SessionPage の URL 遷移を swipe gesture でトリガーするだけ。WS は 1 接続のまま、現在見ている session のみ live を維持
   - 切り出した理由: 「複数 session を同時に live で観察するビュー」は WS 接続数 / メモリ / 電池の設計が大きく重く、Phase 5 で一度に出すには重い。まず「隣 session への移動を片手で速く」だけを Phase 5 で出し、「真の並列ライブビュー」は P1 として独立した phase で扱う

3. **Git context 表示**
   - session header に `branch · +12/-3 (dirty)` のような小さな表示
   - サーバー: `git rev-parse`, `git status --porcelain`, `git diff --stat` を repo path で実行
   - 5 秒ごとにポーリング、または turn 完了後に再取得

4. **launchd による常駐化**
   - `~/Library/LaunchAgents/com.kei.agent-cockpit.plist`
   - PATH 問題に注意（launchd の PATH は空）
   - mobile-first ではないが Phase 5 と独立で完結し、「scheduled cron や push 通知が意味を持つ前提条件」になるので Phase 5 に同梱する

### P1: Phase 6 以降に検討

5. **真の複数セッション並列ライブビュー**
   - 複数 session を同時に WS 接続して live で観察
   - 設計事項: 接続数上限 / inactive session の dehydration / battery saver モード / レイアウト
   - スワイプナビ (P0) とは別の機能として独立フェーズで扱う

6. **Gemini adapter**
   - `gemini` CLI が未インストールなので、まず インストール手順だけ README に書く
   - adapter は base.ts を継ぎ足す形で実装。PATH と spawn の流儀は claude/codex を踏襲
   - 当初 P0 に置いていたが、mobile-first 基準では justify できないので P1 へ降格

7. **Git Worktree / workspace 管理**
   - 各 session が独立した worktree (`<repo>/.worktrees/<session-id>`) を持てるようにする
   - 並列 session が同じファイルを書き換える事故を防ぐ session-first 基盤
   - sessions テーブルに `worktree_path` 追加 / `git worktree add` の lifecycle 管理 / 削除時のクリーンアップ
   - master agent のような「自律オーケストレーション」ではなく「並列実行の安全化」として位置づける

8. **スケジューリング (cron / interval)**
   - サーバーに schedule テーブル + node-cron 相当
   - UI: session detail から「この prompt を毎朝 9 時に流す」を選べる
   - セキュリティ: 任意 prompt の自動実行は事故りやすいので、scheduled prompt は事前承認制にする
   - launchd 常駐 (P0) が前提

9. **状態フィルタとしての session list 拡張**
   - kanban "風" に running / waiting / done でフィルタリング
   - 既存 session list に tab / chip を足すだけで十分

### P2: 後回し

10. **埋め込みターミナル (xterm.js) - secondary mode**
    - chat ビューを主、terminal を escape hatch
    - 範囲は「agent プロセスの生 stdio を覗く debug view」まで。**一般 CLI タスクの実行面は対象外** (それは mosh で行う)
    - 実装コストが大きく、benefits が薄い可能性も

11. **複数 repo 横断ビュー**
    - 「最近触った session を repo 横断で一覧」
    - 既存 session list の sort / filter 拡張

### P3: 却下（実装しない）

- マスターエージェント (Claude Code 側に移譲)
- 自動アップデート機構 (`versions.json` API も不要)
- 月額会員機能 / monetization
- 一般 CLI タスク実行 (mosh / 既存ターミナルの責務)

---

## Phase 5 として推奨するスコープ

P0 の 4 項目だけを Phase 5 として切り出す。Gemini adapter は P1 へ降格、複数セッションは「スワイプナビ」だけに切り詰めた。

| 項目 | 推定影響範囲 | 想定リスク |
|---|---|---|
| Web Push 通知 | server (新ルート + DB), frontend (SW + 設定 UI) | iOS Safari の Web Push は permission 取得タイミングが厳しい |
| モバイル session スワイプナビ | frontend のみ (gesture handler + URL 遷移) | gesture と既存スクロールの競合 |
| Git context 表示 | server (新ルート), frontend (small) | git コマンドの spawn コストとレース |
| launchd 常駐化 | plist + start/stop スクリプト (server コードへの影響は最小) | PATH 空問題、再起動時の token 取り扱い |

それぞれ独立しているので並列に進められる。実装プランは Phase 5 着手時に別途 `docs/plans/YYYY-MM-DD-phase5-*.md` で立てる。

---

## 検証方法

このプラン自体には実装が伴わない（ロードマップ文書）。検証は以下の観点で行う:

1. AGI Cockpit の最新機能を見落としていないか → 上記ソース URL を再確認
2. session-first 哲学と矛盾する項目を P0/P1 に入れていないか → README を再読してチェック
3. 実装可能性 → 各項目の依存技術 (Web Push, node-cron, git CLI, gemini CLI) が現環境で動くか確認

---

## 参考リンク

- AGI Cockpit 公式: https://agilab.tools/cockpit/
- AGI ラボ note (v1.5 リモート対応): https://chatgpt-lab.com/n/nf178a3d39e1d
- AGI ラボ note (v2.0 マスターエージェント): https://chatgpt-lab.com/n/nd2e5ef201888
- AGI Inc: https://www.theagi.company/
