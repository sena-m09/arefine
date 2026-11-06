# aRefine

コーディングエージェントのセッションログなどから人間の指摘を拾い、改善提案を出すツール。
コア（packages/core）と、付け外しできる観点＝refiner（refiners/）の2層で構成する。
設計の詳細は docs/design.md を参照。

## 構成
- packages/core: arefine CLI。入力の収集・正規化・refiner の実行・レポート出力
- packages/core/src/sources: 入力ソースごとのアダプタ（Claude Code・Codex・セルフレビュー）
- refiners/: refiner。1ディレクトリ1 refiner（refiner.yaml・SKILL.md・scripts/）
- plugin/: Claude Code・Codex 向けの配布物

## 設計上のルール
- コアは refiner の中身を知らない。refiner 固有の処理をコアに書かない
- observation は refiner に依存しない共通形式。refiner 固有の情報は refiner 側の状態に持つ
- エージェント固有の処理（ログ形式の読み取り、hook）は sources/ と plugin/ に閉じ込める
- refiner はすべて既定で無効。有効化は設定ファイルで行う

## データの扱い
- 生のセッションログ、そこから取ったコード片をコミットしない
- テストのフィクスチャは匿名化した断片を packages/core/test/fixtures/ に置く

## 実行環境
- パッケージ管理は bun、CLI の実行は Node 24 以上
- CLI はビルドせず、Node が .ts の型注釈を取り除いてそのまま実行する。enum や namespace など、型を消すだけでは動かない構文は使わない（tsconfig の erasableSyntaxOnly で検出する）
- 手元で動かすときは `node packages/core/src/cli.ts --help`。`AREFINE_HOME` を作業用のフォルダに向けると、`~/.arefine/` を汚さずに `collect` を試せる

## コマンド
- 依存のインストール: `bun install`
- テスト: `bun run test`（vitest）
- lint: `bun run lint`（oxlint）
- 型チェック: `bun run typecheck`（tsc）
