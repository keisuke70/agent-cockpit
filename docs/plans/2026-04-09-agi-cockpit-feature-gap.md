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
| **Push 通知** | ✅ Phase 5 で実装済み | turn 完了/error/stop の 3 経路を踏破。Web Push (VAPID) で配信 |
| **スワイプでセッション切替** | ✅ Phase 5 で実装済み | single live, navigate via react-router |
| **Git context 表示** | ✅ Phase 5 で実装済み | session header に branch + dirty バッジ |
| **複数セッション並列ライブビュー (薄い版)** | Phase 6 で実装中 | Lobby WebSocket で全 session の status 遷移を 1 本の WS で broadcast。N 本接続のフルバージョンは P3 永久後退 |
| **スケジューリング (cron)** | Phase 6 で実装中 | node-cron + schedules テーブル + scheduler.ts。interval は cron 式で表現するため別モデルにしない |
| **Kanban 風タスクボード** | Phase 6 で実装中 | フル kanban ではなく状態フィルタ chip (`all / running / idle / error`) として実装 |
| **横断ビュー (cross-repo session list)** | Phase 6 で実装中 | サーバーは既に対応済み。`All Repos` selector + SessionList row の repo 名表示 |
| **埋め込みターミナル (debug view)** | Phase 6 で実装中 | xterm.js は使わず `<pre>` で raw JSONL をストリーム表示。chat が主、debug が secondary |
| **マスターエージェント** | ❌ 恒久却下 | "薄いけど使える MVP" を優先する哲学に反する。Claude Code 自体が orchestration を内包しつつあるので車輪の再発明 |
| **Git Worktree / workspace 管理** | ❌ 恒久却下 | ユーザーが普段の並列 agent 実行でも worktree を使っていない。フォルダ散乱 / 依存重複 / 切替コストの方が高く、想定する事故 (同じファイルの同時編集) が実運用ではほぼ発生しない |
| **Gemini adapter** | ❌ 恒久却下 | ユーザーが gemini CLI を使っていない。需要なし |
| **自動アップデート** | ❌ 恒久却下 | 自作 OSS で配布形態が tarball / git pull 想定なので不要 |
| **versions.json API** | ❌ 恒久却下 | 上に同じ |

---

## 設計判断の要点

1. **session-first を曲げない**: AGI Cockpit は v2.0 以降「task 中心 / kanban 中心」に振っているが、本プロジェクトの README で繰り返し session / prompt / output が主役と宣言している。task board は二次機能のままにする
2. **自作哲学**: master agent のような「魔法のオーケストレーション」は維持コストが高い。Claude Code 側が同等機能を内包する流れもあるので、本プロジェクトはあくまで操作面に集中する
3. **OSS / 単一ユーザー前提**: 配布や monetization 機能は持たない。AGI Cockpit が会員制で吸収しているコスト（パッケージング、サポート）を徹底的に削る
4. **mobile-first を実体化**: 通知 + スワイプ + 並列ビューは「mobile-first を掲げる以上、入っていないと嘘になる」レベル。AGI Cockpit の v1.5 がここに踏み込んだのは正しい判断であり、本プロジェクトもここは追従する

---

## 優先度付き機能ロードマップ

### Phase 5 (実装済み, 2026-04-09)

詳細プラン: `docs/plans/2026-04-09-phase5-mobile-resilience.md`

「mobile-first を掲げるなら入っていないと不誠実」基準で 4 項目を 1 phase でリリース:

1. ✅ **Web Push 通知** — turn 完了/error/stop の 3 経路を踏破。VAPID + subscription DB + Service Worker
2. ✅ **モバイル session スワイプナビ** — single live, react-router navigate
3. ✅ **Git context 表示** — session header に branch + dirty バッジ (5s polling + turn 完了時 refresh)
4. ✅ **launchd 常駐化** — plist + install/uninstall scripts

### Phase 6 (実装中, 2026-04-09)

詳細プラン: `docs/plans/2026-04-09-phase6-observability-and-scheduling.md`

「観察性と自動化を上げる」基準で 5 項目を 1 phase でリリース。Worktree / Gemini を恒久却下にしたうえで残りを束ねる:

1. **状態フィルタ** — HomePage の session list に `all / running / idle / error` chip を追加。Lobby (項目 2) の effectiveStatus を使う
2. **Lobby WebSocket** — 新規 `/ws/lobby` 1 本で全 session の status 遷移を broadcast。HomePage がライブ更新
3. **横断ビュー (cross-repo session list)** — `All Repos` selector + SessionList row に repo 名表示。サーバーは既に対応済み
4. **埋め込みターミナル (debug view)** — Chat / Debug toggle。`<pre>` で raw JSONL をストリーム表示 (xterm.js は不採用)。reconnect 不可の live-only
5. **スケジューリング (cron)** — node-cron + schedules テーブル + scheduler.ts。in-memory single-process / no catch-up / pre-approval なし (single-user trusted 前提)

### P3: 恒久却下（実装しない）

実装哲学・運用実情と矛盾する項目は、ロードマップを clean に保つために永久後退させる:

- **マスターエージェント** — Claude Code 自体が orchestration を内包しつつある。車輪の再発明
- **Git Worktree / workspace 管理** — ユーザーが普段の並列実行でも worktree を使っていない。フォルダ散乱 / 切替コストが高い
- **Gemini adapter** — ユーザーが gemini CLI を使っていない
- **真の複数セッション並列ライブビュー (N 本 WS 同時接続)** — Lobby 版 (Phase 6) で得られる UX 価値の方が高く、N 本接続は接続数 / メモリ / 電池のコストに見合わない
- **自動アップデート機構 / `versions.json` API** — 自作 OSS で配布形態が git pull
- **月額会員機能 / monetization** — single-user 自作ツール
- **一般 CLI タスク実行** — mosh / 既存ターミナルの責務

---

## 検証方法

このプラン自体には実装が伴わない（ロードマップ文書）。検証は以下の観点で行う:

1. AGI Cockpit の最新機能を見落としていないか → 上記ソース URL を再確認
2. session-first 哲学と矛盾する項目を Phase 5/6 に入れていないか → README を再読してチェック
3. 実装可能性 → 各項目の依存技術 (Web Push, node-cron, git CLI) が現環境で動くか確認

---

## 参考リンク

- AGI Cockpit 公式: https://agilab.tools/cockpit/
- AGI ラボ note (v1.5 リモート対応): https://chatgpt-lab.com/n/nf178a3d39e1d
- AGI ラボ note (v2.0 マスターエージェント): https://chatgpt-lab.com/n/nd2e5ef201888
- AGI Inc: https://www.theagi.company/
