<!-- BEGIN SHARED INSTRUCTIONS (auto-synced from agent-skills) -->

## プランモード運用の強制ルール

- プランモードに入ったら、会話中の `proposed_plan` やインライン箇条書きを最終成果物にしてはいけない。正式なプランは必ず `docs/plans/YYYY-MM-DD-<slug>.md` として保存する
- プランが固まってきた段階で、ExitPlanMode 直前ではなく、まずプランファイルを作ってそれを更新し続ける
- `/codex-plan-review` は任意ではなく必須。正式プランを作ったら、完了報告や ExitPlanMode の前に必ず回す
- レビュー実行は repo ルートから `bash .agents/scripts/run-codex-review.sh plan <session-key> < review-prompt.txt` を使う。`scripts/run-codex-review.mjs` を直接叩く前提で考えない
- review が失敗した場合も「今回はインライン案で代替」は不可。ランナーのパス・入力・session key を修正してレビュー成功まで戻す
- Codex review が 5 回以内に `APPROVED` へ到達しない、またはランナー障害が解消しない場合、そのタスクはブロック中として扱う。未承認のまま ExitPlanMode や完了報告へ進んではいけない
- ユーザーが「プランを作って」「プランモードで」と依頼したターンでは、正式プラン作成とレビュー完了までを作業範囲に含める
- Codex の built-in Plan Mode が「repo-tracked file を変更するな」と案内していても、この shared block を使う repo では `docs/plans/...` の作成・更新、review prompt の一時ファイル作成、`bash .agents/scripts/run-codex-review.sh plan ...` の実行は plan-finalization に含まれる必須作業として扱う。実装作業として後回しにしない
- built-in Plan Mode の `<proposed_plan>` は正式成果物の代替ではない。`<proposed_plan>` を出して終わるのではなく、必ず正式プランの保存と review 完了まで進める
- もし現在の Codex 環境が Plan Mode 中の file write / review 実行を hard block して本当に進められない場合は、その環境を「この repo の plan workflow と非互換」と明示してブロック報告する。黙って review を省略しない

## デザインスキル（自動適用）

デザインやUI実装のタスクでは、以下の判断軸を適用すること：

| コンテキスト | スキル | 観点 |
|-------------|--------|------|
| 画面・コンポーネント設計 | ui-designer | 情報設計→視覚階層→コンポーネント化 |
| デザインから実装 | frontend-implementation | ピクセルより意図、マジックナンバーより構造、状態も仕様 |
| アニメーション・インタラクション | creative-coder | 目的ある動き、a11y安全、パフォーマンス意識 |
| UI実装全般 | accessibility-engineer | ネイティブ要素優先、ARIA最小、キーボード基本 |
| UXレビュー・離脱分析 | usability-psychologist | 認知負荷、エラー防止、一貫性 |

共通原則：
- 状態（loading/error/empty/disabled）は後付けではなく仕様として定義
- 場当たりではなくトークン・コンポーネント・パターンで統一
- アクセシビリティは最初から組み込む

---

## プランファイルの命名規則

`docs/plans/` に配置するプランファイルには、必ず作成日の日付プレフィックスをつけること。

- **形式**: `YYYY-MM-DD-<slug>.md`（例: `2026-03-02-waitlist-landing-page.md`）
- プランモードで新規プランを作成する際、ファイル名の先頭に当日の日付を付与する
- 日付のないプランファイルを見つけた場合、git log で作成日を調べてリネームする

---

## Decision Records（設計判断の記録）

`docs/decisions/` に、将来の回帰を防ぐための設計判断を記録する。

- **全変更を書かない** — 壊れやすい判断・ワークアラウンド・直感に反する実装だけ
- テンプレートとルールは [`docs/decisions/README.md`](docs/decisions/README.md) を参照
- バグ修正やアーキテクチャ判断で「これ将来壊れそう」と思ったら記録を追加する
- コードを変更する前に、関連する既存の Decision Record がないか確認すること

---

## プランモード自動レビュー

プランモードでプランが完成したら、ExitPlanMode を呼ぶ**前に**必ず以下を実行すること：
1. `/codex-plan-review` スキルを実行してCodex CLIにプランをレビューさせる
2. Codexが APPROVED を返すまでプランを更新・再レビューする（最大5回）
3. APPROVED 後にのみ ExitPlanMode を呼ぶ

補足:
- `docs/plans/...` の正式ファイルが未作成なら、レビューは未着手扱い。先にファイルを作る
- 会話中の要約や `<proposed_plan>` はレビュー対象の代替にならない
- review コマンドは repo ルートから `bash .agents/scripts/run-codex-review.sh plan <session-key> < review-prompt.txt` を使う
- 5回以内に `APPROVED` しなければ、そのプランは未承認のままブロック。ExitPlanMode は禁止

---

## 実装後の自動コードレビュー

プランモードで承認されたプランの実装が完了した後、**コミットする前に**必ず以下を実行すること：
1. `/codex-impl-review` スキルを実行してCodex CLIに実装コードをレビューさせる
2. Codexが APPROVED を返すまでコードを修正・再レビューする（最大5回）
3. APPROVED 後にのみコミットやユーザへの完了報告を行う

**適用条件**: 3ファイル以上を変更する実装、またはプランモードを経た実装に適用する。
単純な1-2ファイルの修正には不要。

<!-- END SHARED INSTRUCTIONS -->
