# aRefine 設計

## 概要と名前の整理

aRefine は、コーディングエージェントのセッションログなどから「人間の指摘」を拾い、改善提案を出す基盤。旧称 Usoku のリポジトリを aRefine に改め、lint 化プラグイン（旧仮称 lint-garden）は aRefine の最初の「観点」として実装する。

- 入力：Claude Code・Codex のセッションログ、AI セルフレビューの結果、PR レビューコメント
- 構成：ログから改善点を出す「コア」と、どの観点で改善するかを付け外しできる「観点」の2層
- 観点：既定のものを用意しつつ、すべて既定では無効。ユーザー・プロジェクトごとに選んで有効化する
- 出力：まず Markdown のレポート、次の段階で Issue / PR
- 進め方：ユーザー単位のローカル環境で始め、のちにプロジェクトへ導入する

| 旧 | 新 | 備考 |
| --- | --- | --- |
| Usoku（プラグイン管理リポジトリ） | aRefine | リポジトリ名・プロジェクト名 |
| lint-garden（仮称） | lint 化の観点 | 最初に作る観点。名前は ito / itokz を検討中 |
| ハーネス整理を定期実行するプラグイン | aRefine のコアの定期実行 | 独立プラグインにせず統合する案 |
| `lg` コマンド（仮） | `arefine` コマンド | 案 |

lint 化の観点の詳しい経緯と既存ツール調査は、別ドキュメント「lint-garden（仮称）設計まとめ」にある。

## 全体構成

コアは入力の収集と観点への配送だけを担い、何をどう直すかは観点が決める。観点を差し替えてもコアは変わらない。

```
入力    Claude Code / Codex のセッションログ、セルフレビュー結果、PR レビューコメント
  ↓
コア    collect → normalize → dispatch → report
  ↓
観点    lint 化（最初の観点）、スキル改善、コンテキストの入れ方 …
  ↓
出力    Markdown のレポート → のちに Issue / PR
```

最初に作るのは、Claude Code のセッションログを入力に、lint 化の観点で Markdown レポートを出す一本の経路。

## コアの仕様

コアが担うのは、入力を集めて観測に正規化し、有効な観点に渡して、結果をレポートにまとめるところまで。改善の中身（何をどう直すか）は持たない。

### 処理の流れ

1. collect：入力ソースから前回以降の新しい分だけ読む（読み込み位置を記録）。normalize の1段目もここで行う
2. normalize：人間の修正指示・レビュー指摘を取り出し、observation に正規化する
3. dispatch：有効な観点ごとに observation を渡して実行する（`claude -p` または `codex exec`）
4. report：観点ごとの提案を Markdown のレポートにまとめる

normalize は2段で行う。1段目はルールベースで、人間が打った発話と AskUserQuestion への回答だけを候補として取り出し、`candidates.jsonl` に追記する。ツールの結果、hook が差し込んだ文、バックグラウンド処理の通知、サブエージェントへの依頼文、slash command は含めない。2段目は LLM で、候補から修正指示を選んで observation にする。ログの大半は人間の発話ではないので、1段目で LLM に渡す量を減らしてコストを抑えられる。M1 では1段目までを作り、2段目は M2 で dispatch と一緒に入れる。

「OK」「お願い」のような短い返事は1段目では落とさない。10文字以下の発話にも「日本語で頼む」のような指摘が混じっていて、長さや決まり文句で落とすと取りこぼすためで、手元のログで10文字以下は候補の14%ほどなので、2段目に任せてもコストはあまり増えない。

Claude Code のログでは、`type` が `user` で `origin.kind` が `human` のレコードを人間の発話とみなす。`origin` は 2.1.291 以降のログにあることを確かめていて、それより古いログで `origin` を持たないものは読み飛ばす。

AskUserQuestion への回答は、ログ上ではツールの結果として記録され、`toolUseResult` に `questions` と `answers` を持つ。選んだ選択肢や自由に書いた回答も人間の判断なので、質問と回答（メモがあればメモも）を1つの候補にする。候補の `kind` は、打った発話なら `prompt`、回答なら `answer` になる。回答を断った記録は定型文しか持たないので取り出さない。

ログは zod のスキーマで読む。`origin.kind` が `human` のように人間の発話の印はあるのに、ほかのフィールドが想定と違うレコードは、取り出さずに件数だけ数え、`arefine collect` の出力で知らせる。ログの形式が変わったときに、発話を黙って読み飛ばさないようにするため。

### 入力ソース

| 入力 | 読み取り元 | 対応時期 |
| --- | --- | --- |
| Claude Code のセッションログ | `~/.claude/projects/` 以下の jsonl | M1 |
| AI セルフレビューの結果 | `arefine observe` に JSON で渡す | M3 |
| Codex のセッションログ | `~/.codex/sessions/` 以下の jsonl | M4 |
| PR レビューコメント | gh で取得 | プロジェクト導入後 |

セッションログの形式は安定した公開仕様ではない前提で扱う。読み取りはソースごとのアダプタに閉じ込め、形式が変わってもアダプタだけを直せばよいようにする。

### observation の形式

```json
{
  "id": "obs_01JBX...",
  "at": "2026-11-06T10:12:00+09:00",
  "source": "claude-session",
  "repo": "owner/repo",
  "guidance_id": "G-012",
  "summary": "コンポーネント内で fetch を直接呼んでいる",
  "evidence": {
    "file": "src/components/UserCard.tsx",
    "violation": "const res = await fetch(...)",
    "fix": "const user = useUser(id)"
  },
  "ref": { "session": "...", "commit": "abc1234" }
}
```

- `source`：`claude-session` / `codex-session` / `self-review` / `pr-review`
- `guidance_id`：紐づく guidance がなければ `null`。紐づけは観点側でも行える
- observation は観点に依存しない共通形式にする。観点固有の情報はここに足さない

### 保存場所

データと設定は `~/.arefine/` に置く。環境変数 `AREFINE_HOME` で別の場所に変えられる。

```
~/.arefine/
├── config.yaml           # ユーザー単位の設定
├── cursors.json          # セッションログのファイルごとの読み込み位置
├── <owner>__<repo>/
└── _unknown/             # どのリポジトリでの会話か分からないもの
```

1つのセッションの途中で別のリポジトリに移ることがあるので、読み込み位置はリポジトリごとに分けず、ログのファイルごとに持つ。リポジトリは発話の `cwd` から `git remote get-url origin` で求め、削除済みの worktree や git でないフォルダの発話は `cwd` を記録したうえで `_unknown/` に入れる。

手元のログでは発話の約15%が `_unknown/` に入る。大半は collect より先に削除された worktree で、hook でセッション終了ごとに collect を走らせれば減らせる。ただ、普段の作業を止めないことを改善の精度より優先し、いまは減らす仕組みを入れない。

リポジトリごとのディレクトリの中身は次のとおり。

```
<owner>__<repo>/
├── candidates.jsonl      # normalize の1段目で取り出した人間の発話と回答
├── observations.jsonl    # 追記専用の観測ログ
├── refiners/
│   └── lint/             # 観点ごとの状態（lint なら registry.json・proposals/）
└── reports/
    └── 2026-11-06.md     # 実行ごとのレポート
```

ほかの候補と見送った理由は次のとおり。

| 候補 | 見送った理由 |
| --- | --- |
| `~/.local/share/arefine/`（XDG） | macOS では見つけにくい |
| `~/.claude/plugins/data/<id>/`（`CLAUDE_PLUGIN_DATA`） | Claude Code 専用で、CLI 単体や Codex から使いにくい |
| `~/.agents/arefine/` | `~/.agents/` はスキル置き場の慣習で、データ置き場の取り決めがない |

## 観点の仕様と設定

観点（refiner）は「observation を受け取り、提案を返す」ディレクトリ単位の部品で、`refiners/` 以下に置く。コアは観点の中身を知らず、自作の観点を外部ディレクトリから追加できる。

### 観点ディレクトリの形

```
refiners/lint/
├── refiner.yaml       # 名前・説明・使う入力・既定の設定
├── SKILL.md           # 判定手順（エージェントが読む）
└── scripts/           # 任意：ルールのテスト実行など
```

```yaml
# refiner.yaml
name: lint
description: guidance を lint などの機械判定に格上げする提案を出す
inputs: [claude-session, codex-session, self-review]
default_enabled: false
```

観点が守る約束：

- 出力は Markdown の提案。各提案にタイトル、根拠になった observation の ID、変更案を含める
- 状態が必要な観点は `refiners/<name>/` 以下に自分で持つ（コアの observations.jsonl は書き換えない）
- 既定の観点もすべて `default_enabled: false`。使う人が明示的に有効化する

### 設定

| 置き場所 | 用途 |
| --- | --- |
| `~/.arefine/config.yaml` | ユーザー単位。観点の有効化、自作観点の追加、定期実行の頻度 |
| `<repo>/.arefine/config.yaml` | プロジェクト単位。ユーザー設定を上書きする（プロジェクト導入後） |

```yaml
refiners:
  lint:
    enabled: true
    threshold: 3
  skills:
    enabled: false
custom_refiners:
  - ~/dev/my-refiners/context
schedule: weekly
```

既定で同梱する観点の候補は、lint 化・スキル改善・コンテキストの入れ方の3つ。最初は lint 化だけを実装する。

## 最初の観点：lint 化

人間が繰り返し指摘した guidance について、「既存ルールで強制できる」「自作ルールなら可能」「機械判定できない」のどれかを判定し、lint 化の提案を出す。名前は ito / itokz を検討中。

- 判定のタイミング：同じ guidance に紐づく修正指示が N 件以上溜まったとき、セルフレビューで guidance 違反を指摘したとき、定期実行のとき
- guidance ID：AGENTS.md / CLAUDE.md の各ルールに `[G-012]` のような見える ID を付け、セルフレビューが ID を引用して違反を報告できるようにする
- 判定の手順：既存リンタールールを探す → 違反例と修正例（observation の `violation` / `fix`）をテストケースにして自作ルールを試作する → テストに通らなければ棄権して「機械判定不可」とする
- 重さの配分：セルフレビュー時は既存ルールの探索まで。自作ルールの試作は定期実行でまとめて行う
- 状態：`refiners/lint/registry.json` に guidance ごとの判定結果・理由・判定時の観測数・リンターのバージョンを持つ。提案は `refiners/lint/proposals/` に置く
- 再判定：前回判定以降に観測が N 件増えたとき、またはリンターのバージョンが変わったときだけ
- ローカル段階では提案を置くだけで、プロジェクトには自動適用しない

```json
{
  "G-012": {
    "level": "guidance",
    "decision": {
      "result": "custom-rule",
      "reason": "import 元と呼び出し位置で判定可能",
      "judged_at": "2026-11-06T03:00:00+09:00",
      "obs_count_at_judgment": 3,
      "linters": { "eslint": "9.14.0" }
    }
  }
}
```

`level` は `guidance` / `check` / `enforce`、`decision.result` は `existing-rule` / `custom-rule` / `not-mechanizable` / `pending` の4値。

## リポジトリ構成案

コア（CLI）、観点、エージェント向けの配布物を分けて置く。エージェント固有のもの（ログ形式の読み取り、hook）は `sources/` と `plugin/` に閉じ込める。

```
arefine/
├── AGENTS.md                 # 開発ルール
├── CLAUDE.md                 # AGENTS.md を読むよう指示するだけ
├── packages/
│   └── core/                 # arefine CLI（TypeScript / Node）
│       ├── src/
│       │   ├── sources/      # claude-code / codex / self-review のアダプタ
│       │   ├── pipeline/     # collect・normalize・dispatch・report
│       │   └── config/       # ユーザー・プロジェクト設定の読み込み
│       └── test/
│           └── fixtures/     # 匿名化したセッションログの断片
├── refiners/
│   └── lint/                 # 既定の観点（最初はこれだけ）
├── plugin/
│   ├── claude-code/          # plugin.json、hook、スキル
│   └── codex/                # Codex 向けのスキル配置
└── docs/
    └── design.md             # このドキュメントの内容
```

- CLI は TypeScript（Node）で書く。lint 観点で試作する ESLint や Stylelint のルールと同じランタイムでテストできるため
- テストのフィクスチャには、自分のセッションログを匿名化した断片を使う。生のログはコミットしない

## 開発ロードマップ

最初のゴールは、Claude Code のセッションログから修正指示を拾い、lint 観点の提案を Markdown で出す流れを手元で1回通すこと（M2 の完了）。

### M0 準備

- [x] リポジトリを作り、AGENTS.md と CLAUDE.md を置く
- [x] CLI の雛形（`arefine --help`）とテストの実行環境を用意する

### M1 入力

- [x] Claude Code のセッションログを読み、人間の発話を取り出す
- [x] 取り出した発話を candidates.jsonl に追記する（`arefine collect`）
- [x] cursors.json で読み込み位置を記録し、差分だけ読む

### M2 観点と出力

- [ ] candidates.jsonl から修正指示を選び、observation に正規化して observations.jsonl に追記する
- [ ] refiner.yaml と config.yaml を読み、有効な観点を実行する
- [ ] lint 観点：guidance ID への紐づけと、既存リンタールールの探索まで
- [ ] Markdown のレポートを出力する

### M3 定期実行と判定

- [ ] launchd（または cron）から定期実行する
- [ ] セルフレビュー結果を `arefine observe` で取り込む
- [ ] lint 観点の registry.json と再判定条件を実装する
- [ ] 閾値に達した件数と、実際に lint 化できた割合を記録する

### M4 広げる

- [ ] Codex のセッションログに対応する
- [ ] 自作ルールの試作と、テストに通らない場合の棄権を実装する
- [ ] Issue / PR として出力する

## 決めたこと

- CLI のコマンド名は `arefine`
- パッケージマネージャーは bun、テストは vitest、lint は oxlint、型チェックは tsc
- CLI はビルドせず、Node 24 以上で .ts をそのまま実行する。Node は node_modules 内の .ts を実行しないので、パッケージとして配布するときはビルドが必要になる
- データと設定は `~/.arefine/` に置く（「保存場所」を参照）
- normalize はルールベースで絞ってから LLM に渡す2段構え。1段目の結果は candidates.jsonl に置く（「処理の流れ」を参照）
- どのリポジトリでの会話か分からない発話は `_unknown/` にまとめ、減らす仕組みはいまは入れない（「保存場所」を参照）
- 外から読む JSON は zod で検証する。observation や refiner.yaml を外部の観点と共有するときに、`z.toJSONSchema` で形式を公開できるため
- AskUserQuestion への回答も候補に含める（「処理の流れ」を参照）

## 未決事項

該当するマイルストーンまでに決める。

- ハーネス整理の定期実行を、独立プラグインにせずコアに統合してよいか（M3）
- lint 観点の名前（ito / itokz）（M2）
- 完了ゲート menou を aRefine に入れるか、別リポジトリにするか
- 既定の観点のうち、スキル改善とコンテキストの入れ方の中身
- Issue / PR 出力に進む時期と、その前提になる提案の品質基準
