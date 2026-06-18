# Pocket Agent

自作の「スマホから操作しやすい AI エージェント用 web UI」を作るための専用リポジトリ。

## セットアップ

```bash
npm install
npm run dev
```

- サーバー: `http://localhost:3001` (Fastify + WebSocket + SQLite)
- フロントエンド: `http://localhost:3000` (Vite dev server, `/api` と `/ws` を proxy)

初回起動時にサーバーが auth token を生成し、コンソールに表示する。
ブラウザのログイン画面にこのトークンを貼り付けると `localStorage` に保存される。

トークン保管先: `~/Library/Application Support/agent-cockpit/auth-token`
DB 保管先: `~/Library/Application Support/agent-cockpit/cockpit.db`
ログ保管先: `~/Library/Logs/agent-cockpit/server.log`

### Tailscale 経由でスマホから使う

サーバーは `127.0.0.1:3001` にしかバインドしないので、Tailscale Serve で
tailnet 内のみに公開する。

```bash
# build したフロントを 3001 にぶら下げて HTTPS 公開
cd packages/web && npm run build && cd -

# Tailscale Serve で 3001 を 443 に公開（tailnet 内のみ）
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve https / http://127.0.0.1:3001
```

スマホの Tailscale クライアントで Mac mini に接続し、
`https://<machine-name>.<tailnet>.ts.net/` を開いてログイン。

注意: 公開インターネットには絶対に出さない。`tailscale funnel` は使わない。

### 常駐運用 (launchd)

Mac 起動時に自動で Pocket Agent を立ち上げる。

```bash
# 初回 / 再ビルド時
bash scripts/install-launchd.sh

# 停止 / アンインストール
bash scripts/uninstall-launchd.sh
```

`install-launchd.sh` は server / shared / web を build → plist を生成 → `~/Library/LaunchAgents/com.kei.agent-cockpit.plist` に配置 → `launchctl load` する。
ログ:

- stdout: `~/Library/Logs/agent-cockpit/launchd.out.log`
- stderr: `~/Library/Logs/agent-cockpit/launchd.err.log`
- Fastify アプリログ: `~/Library/Logs/agent-cockpit/server.log`

Auth token は `~/Library/Application Support/agent-cockpit/auth-token` に永続保存されているので、launchd 経由で起動しても変わらない。

## このリポジトリを作った背景

- 2026-04-06 時点で `AGI Cockpit` を確認し、この Mac mini にインストールして起動まで確認した。
- ただし、単体買い切りというより **AGIラボの月額メンバーシップ前提の可能性が高い** と判断したため、継続利用はやめる方針にした。
- 代わりに、既にこのマシンに入っている CLI 群（`codex`, `claude` など）を束ねる **自作 cockpit** を別 repo で作ることにした。

## 重要な前提補正

このプロジェクトは、最初の議論では「タスク監督 / カンバン管理」寄りに整理されていたが、
その後の補足で **主目的はそこではない** ことが明確になった。

本当に作りたいものは:

- **この web UI 上で普通にプロンプトを打って開発する**
- つまり **ターミナルでプロンプトを打つ体験を、web でより良い UX に置き換える**
- スマホからでも使いやすくする

したがって、このプロジェクトは **task board first** ではなく、
**session / prompt first** のプロダクトとして扱うこと。

カンバンやタスク一覧は入ってもよいが、あくまで二次機能。

## 目的

主目的は **スマホから見やすく・触りやすい Web UI** で、
`codex` / `claude` などの CLI に対して **普通にプロンプトを打ちながら開発すること**。

特に欲しいのは以下:

- web 上で prompt composer から入力できる
- 出力をストリーミングで読める
- セッションを途中から再開できる
- repo / working directory / agent を選べる
- スマホでも「ターミナルより気持ちよく」操作できる
- 必要ならログや履歴を後から見返せる

## 前提の運用イメージ

- 普段の操作は **Web UI を主** にする
- 既存の **Termux + mosh** ワークフローは **副系統として残す**
- つまり方針は **Web を daily driver、mosh を escape hatch** とする

Web でやりたいこと:

- 普通に prompt を打つ
- 出力をその場で追う
- 同じ session を継続する
- repo を切り替える
- 必要なら stop / retry / branch 確認などを行う
- ログ / 履歴を見る

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
**1つの Web UI から prompt 駆動で使うための session-first なフロントエンド** を作る。

言い換えると、これは

- 「AI タスク管理ツール」を作るのではなく
- **CLI エージェント用の web-native な操作面** を作るプロジェクト

である。

最初に重視する中心概念は以下:

1. **Session**
2. **Prompt / Message**
3. **Repo / Working Directory**
4. **Output Stream / 履歴**

### 最初から狙わないこと

以下は後回しでよい:

- 完全な IDE 代替
- デスクトップ専用ネイティブアプリ化
- 高度な権限分離
- 複雑すぎる自動化 DSL
- いきなり全部入りの multi-agent platform
- 最初から task orchestration / kanban を主役にすること

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

frontend は特に、

- chat 風の prompt 入力
- terminal/log の streaming 表示
- session 切り替え
- repo / agent 切り替え

を自然に扱える UI にする。

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
2. agent を選べる（最低 `codex` / `claude`）
3. session を新規作成 / 一覧表示 / 再開できる
4. web 上の composer から prompt を送れる
5. 出力をストリーム表示できる
6. stop / retry / resume などの基本操作ができる
7. スマホで見やすい UI にする

MVP の主画面候補:

- Session list
- Session detail
  - prompt composer
  - streaming output
  - session metadata
- Repo / agent selector

カンバンを入れるとしても、最初は session 一覧の表示バリエーション程度でよい。

## 今後の拡張候補

- セッション再開の改善
- Git branch / diff の要約表示
- よく使う prompt のテンプレ化
- 複数 repo 横断ビュー
- 通知
- cron / interval ベースの定期実行
- カンバン / task view
- 失敗時の自動再試行

## UI の大原則

スマホ利用が前提なので、**「入力しやすさ」と「読みやすさ」** を最優先にする。

ここで重要なのは、以前の整理と違って
**このプロダクトでは prompt 入力そのものが主役** だということ。

つまり、「極力文字を打たせない」ではなく、
**文字を打つ体験をスマホでも快適にする** のが正しい。

特に mobile first で重視したいこと:

- 下部固定 composer など、入力しやすいこと
- ストリーミング出力が読みやすいこと
- 片手で押しやすい操作であること
- セッション切り替えが簡単であること
- stop / retry / copy などの即時操作がしやすいこと
- 長いログでも破綻しないこと
- 必要時だけ詳細 terminal view に降りられること

## 将来のエージェント / 開発者向けメモ

この repo を引き継ぐ別エージェントは、まず以下を前提として扱うこと:

1. このプロジェクトの主目的は **web で普通に prompt を打って開発すること**
2. 主役は **task** ではなく **session / prompt / output**
3. **mosh は置き換えず、補助系として残す**
4. **複数 repo を扱える前提** で設計する
5. **runtime data は repo 外** に置く
6. **localhost + Tailscale** を基本の公開モデルとする
7. **CLI 実行時の PATH 問題** を軽視しない
8. 最初は大きく作りすぎず、**薄いけど使える MVP** を優先する
9. カンバンや orchestration は二次機能であり、初期の主戦場ではない

## 次の作業でやるとよさそうなこと

このあと別のエージェントで進める際は、まず以下をやるとよい:

1. 実装プランを作る
2. repo 構成を確定する
3. **session-first** の画面一覧を決める
4. server 側の **session / prompt / stream** モデルを決める
5. `codex` / `claude` 起動方法と PATH の扱いを明文化する
6. Tailscale 経由の公開方法を固める
7. 必要なら launchd 常駐化の方針を決める
8. task / kanban を MVP に入れるか、後回しにするか明確化する

## ひとことで言うと

これは「AI IDE」を作るプロジェクトでも、「タスク管理 SaaS」を作るプロジェクトでもなく、
**Mac mini 上で動く CLI エージェント群に対して、web から気持ちよく prompt を打って開発できる操作面を作るプロジェクト**。
