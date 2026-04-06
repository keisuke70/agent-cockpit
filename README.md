# agent-cockpit

自作の「スマホから操作しやすい AI エージェント用 cockpit」を作るための専用リポジトリ。

## このリポジトリを作った背景

- 2026-04-06 時点で `AGI Cockpit` を確認し、この Mac mini にインストールして起動まで確認した。
- ただし、単体買い切りというより **AGIラボの月額メンバーシップ前提の可能性が高い** と判断したため、継続利用はやめる方針にした。
- 代わりに、既にこのマシンに入っている CLI 群（`codex`, `claude` など）を束ねる **自作 cockpit** を別 repo で作ることにした。

## 目的

主目的は **スマホから見やすく・触りやすい Web UI** で、AI タスクを監督・操作すること。

特に欲しいのは以下:

- カンバンでタスク状態を把握する
- タスクを開始 / 停止 / 再実行する
- レビュー待ちを確認する
- ログをスマホから見る
- 必要なら簡単な追加入力をする

## 前提の運用イメージ

- 普段の操作は **Web UI を主** にする
- 既存の **Termux + mosh** ワークフローは **副系統として残す**
- つまり方針は **Web を daily driver、mosh を escape hatch** とする

Web でやりたいこと:

- タスク一覧確認
- カンバン操作
- 承認 / 差し戻し / 再実行
- 進行状況確認
- ログ閲覧

mosh で残したいこと:

- 生のシェル操作
- 緊急対応
- デバッグ
- 手作業での微修正

## なぜ別 repo にするか

このツールは特定アプリ repo の一部ではなく、複数 repo をまたいで使う前提になりやすい。
そのため、以下の理由で専用 repo とする。

- 複数 repo を管理しやすい
- UI / backend / sqlite / pty 依存を本体 repo に混ぜない
- 事故や権限の切り分けがしやすい
- Mac mini 常駐ツールとして独立運用しやすい

## このマシンの事実メモ

この repo 作成時点で確認済み:

- マシン: **Mac mini**
- SoC: **Apple M4**
- OS: **macOS 15.6**
- 既存 CLI:
  - `codex`: `/opt/homebrew/bin/codex`
  - `claude`: `/Users/kei/.local/bin/claude`
  - `gemini`: 未導入
- その他:
  - `git`: `/usr/bin/git`
  - `node`: `/opt/homebrew/bin/node`
  - `npm`: `/opt/homebrew/bin/npm`
  - `pnpm`: 未導入
  - `bun`: 未導入
- Tailscale:
  - アプリはインストール済み
  - プロセスは動作中
  - CLI は通常の `PATH` には載っていない可能性あり
  - `/Applications/Tailscale.app/Contents/MacOS/Tailscale version` は実行可能

## 重要な環境メモ

### PATH について

アプリやバックグラウンドサービスから CLI を叩く場合、`PATH` の扱いに注意すること。
この確認時点ではシェル上の `PATH` は通っているが、`launchd` の `PATH` は空だった。

つまり、将来 `launchd` / 常駐プロセス / GUI 起動 で `codex` や `claude` を呼ぶ場合は、
**PATH を明示設定する前提** で設計した方が安全。

### 電源 / 常駐性について

確認時点の `pmset -g custom` の要点:

- `sleep 0`
- `displaysleep 10`
- `womp 1`
- `tcpkeepalive 1`

このため、常駐マシンとしての前提はそこまで悪くない。

## プロダクト方針

### 何を作るか

`codex` / `claude` / 将来的には `gemini` などの CLI ベースエージェントを、
**1つの Web UI から監督・操作できる小さな orchestrator** を作る。

### 最初から狙わないこと

以下は後回しでよい:

- 完全な IDE 代替
- デスクトップ専用ネイティブアプリ化
- 高度な権限分離
- 複雑すぎる自動化 DSL
- いきなり全部入りの multi-agent platform

最初は **薄いが実用的な cockpit** を目指す。

## 想定アーキテクチャ（たたき台）

これはまだ確定ではないが、現時点での自然な候補:

- frontend: **React + Vite + PWA**
- backend: **Node.js + TypeScript**
- API: HTTP + WebSocket
- terminal/log streaming: **node-pty + xterm.js**
- storage: **SQLite**
- validation: `zod`
- repo 構成: **npm workspaces**

npm workspaces を推す理由:

- このマシンには Node / npm が既にある
- pnpm / bun は未導入
- まずは導入摩擦を減らしたい

## 公開 / 接続方針

基本方針:

- backend / web app は **localhost bind** を基本にする
- スマホからのアクセスは **Tailscale 越し** を第一候補にする
- 可能であれば **Tailscale Serve** で tailnet 内のみ公開する
- 公開インターネットへは出さない前提で考える

## データ配置方針

runtime data は repo の中に置かない。

想定例:

- config / db / session / state:
  - `~/Library/Application Support/agent-cockpit/`
- logs:
  - `~/Library/Logs/agent-cockpit/`

repo はコードだけを持ち、運用データは外に逃がす方針。

## まず欲しい MVP

優先度高:

1. 管理対象 repo を登録できる
2. タスクを作成できる
3. agent を選べる（最低 `codex` / `claude`）
4. タスクを実行できる
5. 出力ログをストリーム表示できる
6. タスク状態をカンバンで見られる
7. スマホで見やすい UI にする

初期カラム案:

- `Queued`
- `Running`
- `Review`
- `Done`

カードに欲しい最低限の操作:

- Start
- Stop
- Retry
- Approve
- Add note

## 今後の拡張候補

- セッション再開
- Git branch / diff の要約表示
- cron / interval ベースの定期実行
- 通知
- 複数 repo 横断ビュー
- テンプレプロンプト
- 失敗時の自動再試行

## UI の大原則

スマホ利用が前提なので、**「文字をたくさん打たせる UI」より「タップ中心の UI」** を優先する。

特に mobile first で重視したいこと:

- 片手で押しやすい操作
- カード一覧の見やすさ
- 状態変化が一目でわかること
- 長いログは読みやすく折りたたむこと
- 緊急時だけ詳細ターミナルに降りられること

## 将来のエージェント / 開発者向けメモ

この repo を引き継ぐ別エージェントは、まず以下を前提として扱うこと:

1. このプロジェクトは **スマホからの Web 操作が主目的**
2. **mosh は置き換えず、補助系として残す**
3. **複数 repo を扱える前提** で設計する
4. **runtime data は repo 外** に置く
5. **localhost + Tailscale** を基本の公開モデルとする
6. **CLI 実行時の PATH 問題** を軽視しない
7. 最初は大きく作りすぎず、**薄いけど使える MVP** を優先する

## 次の作業でやるとよさそうなこと

このあと別のエージェントで進める際は、まず以下をやるとよい:

1. 実装プランを作る
2. repo 構成を確定する
3. MVP の画面一覧を決める
4. server 側の task/session モデルを決める
5. `codex` / `claude` 起動方法と PATH の扱いを明文化する
6. Tailscale 経由の公開方法を固める
7. 必要なら launchd 常駐化の方針を決める

## ひとことで言うと

これは「AI IDE」を作るプロジェクトではなく、
**Mac mini 上で動く CLI エージェント群を、スマホから気持ちよく監督するための cockpit を作るプロジェクト**。
