# aRefine

コーディングエージェントのセッションログなどから人間の指摘を拾い、改善提案を出すツール。
コア（packages/core）と、付け外しできる観点＝refiner（refiners/）の2層で構成する。
設計の詳細は docs/design.md を参照。

ルールの頭の `[G-001]` は guidance ID で、aRefine がどのルールについての指摘かを結びつけるのに使う。
文面を直しても番号は変えず、消したルールの番号は使い回さない。ルールを足したら、いま使っている最大の番号の次を振る。

## 構成
- packages/core: arefine CLI。入力の収集・正規化・refiner の実行・レポート出力
- packages/core/src/sources: 入力ソースごとのアダプタ（Claude Code・Codex・セルフレビュー）
- refiners/: refiner。1ディレクトリ1 refiner（refiner.yaml・SKILL.md・scripts/）
- plugin/: Claude Code・Codex 向けの配布物
- tools/lint/: oxlint のローカルルール

## 設計上のルール
- [G-001] コアは refiner の中身を知らない。refiner 固有の処理をコアに書かない
- [G-002] observation は refiner に依存しない共通形式。refiner 固有の情報は refiner 側の状態に持つ
- [G-003] エージェント固有の処理（ログ形式の読み取り、hook）は sources/ と plugin/ に閉じ込める
- [G-004] refiner はすべて既定で無効。有効化は設定ファイルで行う
- [G-005] ログや設定など外から読む JSON は、zod のスキーマを通してから使う
- [G-006] 型アサーション（`as`）と non-null アサーション（`!`）は使わない。型注釈・`satisfies`・zod・条件分岐で型を付ける。`as const` だけは使ってよい
- [G-007] どうしても要るときは、`// oxlint-disable-next-line typescript/consistent-type-assertions -- 理由`（`!` なら typescript/no-non-null-assertion）で理由を書いて1行だけ外す
- [G-008] `let` は使わない。try/catch で値を決めるなら関数に切り出して return する。テストは beforeEach で共有変数を書き換えず、テストごとに setup 関数を呼ぶ
- [G-009] 配列の変換は map・filter・flatMap で書き、ファイル書き込みのような副作用を伴う繰り返しだけ for...of を使う。添字の for・for...in・while・forEach は使わない
- [G-010] `let` とループの制限は tools/lint/local.ts のローカルルールで検出する。AI が書きがちで避けたい書き方を見つけたら、AGENTS.md に書くだけでなく lint のルールにできないかを先に考える

## データの扱い
- [G-011] 生のセッションログ、そこから取ったコード片をコミットしない
- [G-012] テストのフィクスチャは、判定に要るフィールドだけを持つレコードを手で書き、packages/core/test/fixtures/ に置く。実際のログを削って使わない。`cwd` などのパスは `/home/user/example` のような架空のものにする

## 進め方
- [G-013] 作業はマイルストーンごとの GitHub issue（docs/design.md の「開発ロードマップ」から辿れる）を起点にする。着手前に issue の「着手時に決めること」を確認し、決まっていなければ先に決める
- [G-014] issue ごとにブランチを切り、PR にする。main へ直接コミットしない
- [G-015] PR を出す前に `bun run lint`・`bun run typecheck`・`bun run test` を通す。CI でも同じものが回る
- [G-016] 実際のログでの確認は、`AREFINE_HOME` を作業用のフォルダに向けて行う。本物の `~/.arefine/` には書かない
- [G-017] 方針を決めたり変えたりしたら、docs/design.md の該当セクションと「決めたこと」「未決事項」を同じ PR で更新する

## 実行環境
- パッケージ管理は bun、CLI の実行は Node 24 以上
- [G-018] CLI はビルドせず、Node が .ts の型注釈を取り除いてそのまま実行する。enum や namespace など、型を消すだけでは動かない構文は使わない（tsconfig の erasableSyntaxOnly で検出する）
- 手元で動かすときは `node packages/core/src/cli.ts --help`。`AREFINE_HOME` を作業用のフォルダに向けると、`~/.arefine/` を汚さずに `collect` を試せる

## コマンド
- 依存のインストール: `bun install`
- テスト: `bun run test`（vitest）
- lint: `bun run lint`（oxlint）
- 型チェック: `bun run typecheck`（tsc。tools/lint のローカルルールも対象）
