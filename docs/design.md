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
| lint-garden（仮称） | lint 化の観点 | 最初に作る観点。名前は `lint` |
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

normalize は2段で行う。1段目はルールベースで、人間が打った発話と AskUserQuestion への回答だけを候補として取り出し、`candidates.jsonl` に追記する。ツールの結果、hook が差し込んだ文、バックグラウンド処理の通知、サブエージェントへの依頼文、slash command は含めない。2段目は LLM で、候補から修正指示を選んで observation にする。ログの大半は人間の発話ではないので、1段目で LLM に渡す量を減らしてコストを抑えられる。

2段目は、候補を20件ずつまとめて `claude -p` に渡し、修正指示を含むものだけを observation にして `observations.jsonl` に追記する。1つの発話に別々の指示があれば、指示ごとに observation を分ける。どこまで処理したかは、まとまりごとに `progress.json` に記録する。LLM の呼び出しに失敗したまとまりは処理済みにしないので、次の実行でやり直す。observation の `id` は候補の `id` から決めるので、同じ候補を処理し直しても observation は重複しない。リポジトリが分からない候補（`_unknown/`）は、観点に渡しても提案の行き先がないので処理しない。

`claude -p` は、セッションを保存しない設定（`--no-session-persistence`）で呼ぶ。保存すると、次の collect が aRefine の呼び出しを人間の発話として拾ってしまうため。ユーザーの設定・hook・MCP サーバーも読み込まない。

`arefine run` は collect・normalize・dispatch・report を続けて実行する。有効な観点が1つもなければ、normalize より前で止めて LLM を呼ばない。`--repo owner/name` を付けると、normalize と dispatch をそのリポジトリだけに絞る。collect は LLM を使わないので、絞らずに全体を読む。候補がなく、`arefine observe` で追記した observation だけがあるリポジトリも、観点に渡す対象に入れる。

「OK」「お願い」のような短い返事は1段目では落とさない。10文字以下の発話にも「日本語で頼む」のような指摘が混じっていて、長さや決まり文句で落とすと取りこぼすためで、手元のログで10文字以下は候補の14%ほどなので、2段目に任せてもコストはあまり増えない。

Claude Code のログでは、`type` が `user` で `origin.kind` が `human` のレコードを人間の発話とみなす。`origin` は 2.1.291 以降のログにあることを確かめていて、それより古いログで `origin` を持たないものは読み飛ばす。

AskUserQuestion への回答は、ログ上ではツールの結果として記録され、`toolUseResult` に `questions` と `answers` を持つ。選んだ選択肢や自由に書いた回答も人間の判断なので、質問と回答（メモがあればメモも）を1つの候補にする。候補の `kind` は、打った発話なら `prompt`、回答なら `answer` になる。回答を断った記録は定型文しか持たないので取り出さない。

セッションを再開・分岐すると、同じ発話（同じ `uuid`）が別のログファイルにも残る。collect は、すでに取り出した `uuid` の発話と、同じセッションで同じ文面を送り直した発話を取り出さない。観点は件数で提案するかを決めるので、同じ発話を何度も数えないようにするため。別のセッションで同じことを言ったものは、繰り返し出た指摘として別々に数える。

ログは zod のスキーマで読む。`origin.kind` が `human` のように人間の発話の印はあるのに、ほかのフィールドが想定と違うレコードは、取り出さずに件数だけ数え、`arefine collect` の出力で知らせる。ログの形式が変わったときに、発話を黙って読み飛ばさないようにするため。

### 入力ソース

| 入力 | 読み取り元 | 対応時期 |
| --- | --- | --- |
| Claude Code のセッションログ | `~/.claude/projects/` 以下の jsonl | M1 |
| AI セルフレビューの結果 | `arefine observe` に JSON で渡す | M3 |
| Codex のセッションログ | `~/.codex/sessions/` 以下の jsonl | M4 |
| PR レビューコメント | gh で取得 | プロジェクト導入後 |

セッションログの形式は安定した公開仕様ではない前提で扱う。読み取りはソースごとのアダプタに閉じ込め、形式が変わってもアダプタだけを直せばよいようにする。

### 候補（candidate）の形式

`arefine collect` が `candidates.jsonl` に追記する1行の形。M2 の normalize の2段目はこれを読んで observation を作る。

```json
{
  "id": "1f0c…",
  "kind": "prompt",
  "at": "2026-11-06T01:12:00.000Z",
  "source": "claude-session",
  "repo": "owner/repo",
  "cwd": "/Users/me/works/repo",
  "text": "コンポーネントで fetch を直接呼ばないで",
  "ref": { "session": "…", "log": "/Users/me/.claude/projects/…/….jsonl" }
}
```

- `id`：セッションログのレコードの `uuid`
- `kind`：打った発話なら `prompt`、AskUserQuestion への回答なら `answer`。`answer` の `text` は「質問: …」「回答: …」「メモ: …」の行を質問ごとにまとめたもの
- `repo`：分からなければ `null`（そのときは `_unknown/` に入る）
- `ref.log`：元のセッションログのパス。発話の前後のやり取り（AI が何をしたか）を読むときに使う

### observation の形式

`observations.jsonl` の1行の形。スキーマは packages/core/src/pipeline/observation.ts にある。

```json
{
  "id": "obs_1f0c…_1",
  "at": "2026-11-06T01:12:00.000Z",
  "source": "claude-session",
  "repo": "owner/repo",
  "cwd": "/Users/me/works/repo",
  "guidance_id": null,
  "summary": "コンポーネントで fetch を直接呼ばない",
  "ref": { "candidate": "1f0c…", "session": "…", "log": "/Users/me/.claude/projects/…/….jsonl" }
}
```

セルフレビューから作った observation は、guidance ID と違反したコードを持ち、元の発話がないので `ref` の `candidate` と `log` は `null` になる。

```json
{
  "id": "obs_review_a7ca…",
  "at": "2026-11-06T03:00:00.000Z",
  "source": "self-review",
  "repo": "owner/repo",
  "cwd": "/Users/me/works/repo",
  "guidance_id": "G-006",
  "summary": "型アサーションを使わない",
  "evidence": { "violation": "const user = data as User;", "fix": "const user = User.parse(data);" },
  "ref": { "candidate": null, "session": "…", "log": null }
}
```

- `id`：セッションログからなら `obs_<候補の id>_<その候補の中での連番>`。セルフレビューからなら `obs_review_<ハッシュ>`（「セルフレビューの取り込み」を参照）
- `source`：`claude-session` / `codex-session` / `self-review` / `pr-review`
- `cwd`：発話したときの作業フォルダ。観点がリポジトリのファイルを読むときに使う
- `guidance_id`：normalize では `null` にする。どの guidance への指摘かは、AGENTS.md を読める観点の側で結びつける。セルフレビューが ID を引用していれば、それを入れる
- `summary`：指示の中身を「〜しない」「〜する」の形で書いた1文
- `evidence`：違反したコード（`violation`）と、直したコード（`fix`、なければ `null`）。セルフレビューが渡したときだけ持つ。発話からは分からないので、セッションログからの observation には付けない
- `ref`：元の記録への参照。分からない項目は `null`
- observation は観点に依存しない共通形式にする。観点固有の情報はここに足さない

### セルフレビューの取り込み

`arefine observe` は、セルフレビューの結果を標準入力から JSON で受け取り、zod で検証してから observation として `observations.jsonl` に追記する。LLM は呼ばない。

```json
{
  "cwd": "/Users/me/works/repo",
  "session": "…",
  "findings": [
    {
      "guidance_id": "G-006",
      "summary": "型アサーションを使わない",
      "evidence": { "violation": "const user = data as User;", "fix": "const user = User.parse(data);" }
    }
  ]
}
```

- 必須なのは `findings` と、その各要素の `summary` だけ。指摘がなければ `findings` は空でよい
- `cwd`：レビューしたリポジトリのフォルダ。省くと `arefine observe` を実行したフォルダになる。リポジトリは collect と同じく `git remote get-url origin` で求め、分からなければ何も追記せずに止める（`_unknown/` は run が処理しないので置かない）
- `session`：セルフレビューを回したセッションの ID。省いてよい
- `guidance_id`：引用した guidance ID（`G-006` の形）。対応するルールがなければ省く
- `evidence`：省いてよい。`fix` だけ省くこともできる

形が違えば、どの項目が違うかを示して止め、1件も追記しない。一部だけ追記すると、直して送り直したときに重複するため。

observation の `id` は、リポジトリ・`session`・`guidance_id`・`summary`・`violation` から作るハッシュにする。同じ結果を2回渡しても1件のままにし、別のセッションでの同じ指摘は別に数える。collect が同じ発話を重複して数えず、別のセッションで同じことを言ったものは別々に数えるのと揃えた。`session` を省くと、同じ指摘は何度渡しても1件になる。

### 保存場所

データと設定は `~/.arefine/` に置く。環境変数 `AREFINE_HOME` で別の場所に変えられる。

```
~/.arefine/
├── config.yaml           # ユーザー単位の設定
├── cursors.json          # セッションログのファイルごとの読み込み位置
├── run.lock              # collect・run の実行中だけある。中身は実行している pid
├── logs/
│   └── run.log           # 定期実行の出力
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
├── progress.json         # normalize と、観点ごとの dispatch をどこまで処理したか
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

### 定期実行

`arefine schedule` は、`arefine run` を launchd から定期実行するための plist を `~/Library/LaunchAgents/arefine.run.plist` に書き出し、登録と解除のコマンドを表示する。登録は利用者が自分で行う。

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/arefine.run.plist   # 登録
launchctl bootout gui/$(id -u)/arefine.run                                  # 解除
rm ~/Library/LaunchAgents/arefine.run.plist
```

- 頻度は config.yaml の `schedule` から plist を作るときに決まる。頻度を変えたときや Node を入れ替えたときは、`arefine schedule` をやり直し、bootout してから bootstrap し直す
- 時刻を決めて動かす（`StartCalendarInterval`）。スリープ中に過ぎた分は、起きたときに1回だけ動く
- launchd から起動すると PATH がほぼ空になり、`claude` と `git` が見つからない。そのため plist に、書き出したときの `PATH` と、設定されていれば `AREFINE_HOME`・`CLAUDE_CONFIG_DIR` を書く。Node と cli.ts も絶対パスで書くので、plist は使い続けるチェックアウトで書き出す
- 出力は `~/.arefine/logs/run.log` に追記する
- 普段の作業を止めないよう、`ProcessType: Background` と `LowPriorityIO` で優先度を下げる。launchd のジョブなので、失敗しても作業中のセッションには影響しない

collect と run は、`~/.arefine/run.lock` で同時に1つしか動かないようにする。ロックを取れなかった実行は、何もせずに正常終了する。手で動かした run と定期実行が重なっても、候補や observation が二重にならないようにするため。ロックの中身は pid で、その pid のプロセスがもう動いていなければ、前の実行が途中で落ちた残りとみなして取り直す。observe は追記するだけなのでロックを取らない。

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

dispatch では、観点ごとに `SKILL.md` をシステムプロンプトにして `claude -p` を呼び、まだ渡していない observation（最大100件）と、config.yaml にあるその観点の設定を渡す。observation の `source` が観点の `inputs` にないものは渡さない。発話の `cwd` が残っていれば、そこを作業フォルダにして Read・Grep・Glob だけを使えるようにする。観点はリポジトリの AGENTS.md やリンターの設定を読めるが、ファイルは書き換えられない。

観点が守る約束：

- 出力は提案の一覧。各提案にタイトル（`title`）、根拠になった observation の ID（`observation_ids`）、Markdown で書いた変更案（`change`）を含める。コアがこれを `reports/<日付>.md` にまとめる
- 状態が必要な観点は `refiners/<name>/` 以下に自分で持つ（コアの observations.jsonl は書き換えない）
- 既定の観点もすべて `default_enabled: false`。使う人が明示的に有効化する

### 設定

| 置き場所 | 用途 |
| --- | --- |
| `~/.arefine/config.yaml` | ユーザー単位。観点の有効化、自作観点の追加、定期実行の頻度 |
| `<repo>/.arefine/config.yaml` | プロジェクト単位。ユーザー設定を上書きする（プロジェクト導入後） |

```yaml
budget_usd: 1
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

`budget_usd` は1回の実行で LLM に使ってよい金額の上限（ドル）で、既定は1。`schedule` は定期実行の頻度で、`daily`（毎日 3:00、既定）か `weekly`（毎週月曜 3:00）。`enabled` 以外の観点の設定は、コアは読まずにそのまま観点に渡す。

1回の実行で使った LLM の費用を足し合わせ、上限に達したらそれ以降の呼び出しを始めない。処理しきれなかった候補と observation は次の実行に回す。上限に達する直前の呼び出しは最後まで実行するので、使う金額は上限を1回分の呼び出し（数セント）ほど超えることがある。`claude -p` の `--max-budget-usd` には残りの金額ではなく上限そのものを渡し、1回の呼び出しが上限を超えて続いたときの歯止めにだけ使う。`--max-budget-usd` は超えた時点で結果を捨てて止めるので、残りの金額を渡すと、上限の直前の呼び出しが費用だけかかって結果を残さない。

既定で同梱する観点の候補は、lint 化・スキル改善・コンテキストの入れ方の3つ。最初は lint 化だけを実装する。

## 最初の観点：lint 化

人間が繰り返し指摘した guidance について、「既存ルールで強制できる」「自作ルールなら可能」「機械判定できない」のどれかを判定し、lint 化の提案を出す。観点の名前は `lint`。

- 判定のタイミング：同じ guidance に紐づく修正指示が N 件以上溜まったとき、セルフレビューで guidance 違反を指摘したとき、定期実行のとき
- guidance ID：AGENTS.md / CLAUDE.md の各ルールに `[G-012]` のような見える ID を付け、セルフレビューが ID を引用して違反を報告できるようにする（「guidance ID の振り方」を参照）
- 判定の手順：既存リンタールールを探す → 違反例と修正例（observation の `evidence.violation` / `evidence.fix`）をテストケースにして自作ルールを試作する → テストに通らなければ棄権して「機械判定不可」とする
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

M2 の lint 観点は、registry.json を持たずに、渡された observation だけで判定する。そのため `threshold` は1回の dispatch で渡した observation の中での件数になり、実行をまたいだ件数は数えない。`threshold` に届かない指示も、レポートの「様子を見る指示」に一覧で残す。実行をまたいだ件数は、M3 で registry.json を入れるときに数える。

### guidance ID の振り方

- 振る対象は、各リポジトリの AGENTS.md と、ルールを直接書いている CLAUDE.md。`@AGENTS.md` のように読み込むだけの CLAUDE.md には振らない
- 振るのは AI に守らせたいルールの行だけ。構成の説明やコマンドの一覧のような、ルールでない行には振らない
- 形は行頭の `[G-001]`。番号は3桁で、リポジトリの中で通し番号にする
- 文面を直しても番号は変えない。消したルールの番号は使い回さず、新しいルールには使っている最大の番号の次を振る
- ユーザー単位の `~/.claude/CLAUDE.md` などは、プロジェクトに導入するときにあらためて決める

このリポジトリの AGENTS.md に最初に振った。

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
│       │   ├── config/       # ユーザー・プロジェクト設定の読み込み
│       │   └── schedule/     # launchd の plist の書き出し
│       └── test/
│           └── fixtures/     # 匿名化したセッションログの断片
├── refiners/
│   └── lint/                 # 既定の観点（最初はこれだけ）
├── plugin/
│   ├── claude-code/          # plugin.json、hook、スキル
│   └── codex/                # Codex 向けのスキル配置
├── tools/
│   └── lint/                 # oxlint のローカルルール（let・添字ループの禁止）
├── .github/workflows/        # CI（lint・型チェック・テスト）
└── docs/
    └── design.md             # このドキュメント
```

- CLI は TypeScript（Node）で書く。lint 観点で試作する ESLint や Stylelint のルールと同じランタイムでテストできるため
- テストのフィクスチャは、判定に要るフィールドだけを持つレコードを手で書く。実際のログを削って使うとパスや会話の文面が残るので、生のログからは作らない

## 開発ロードマップ

最初のゴールは、Claude Code のセッションログから修正指示を拾い、lint 観点の提案を Markdown で出す流れを手元で1回通すこと（M2 の完了）。

マイルストーンごとの作業と進み具合は GitHub の issue で管理する。ここには各マイルストーンの狙いだけを書く。

| マイルストーン | 狙い | 状態 |
| --- | --- | --- |
| M0 準備 | リポジトリ、AGENTS.md、`arefine --help` が動く CLI とテスト環境 | 完了 |
| M1 入力 | Claude Code のセッションログから人間の発話と回答を取り出す（`arefine collect`） | 完了（#1） |
| M2 観点と出力 | 候補を observation にし、lint 観点で Markdown レポートを出す（`arefine run`） | #2 |
| M3 定期実行と判定 | launchd からの定期実行、セルフレビューの取り込み、lint 観点の判定記録 | #3 |
| M4 広げる | Codex 対応、自作ルールの試作、Issue / PR 出力 | #4 |

## 決めたこと

- CLI のコマンド名は `arefine`
- パッケージマネージャーは bun、テストは vitest、lint は oxlint、型チェックは tsc
- CLI はビルドせず、Node 24 以上で .ts をそのまま実行する。Node は node_modules 内の .ts を実行しないので、パッケージとして配布するときはビルドが必要になる
- データと設定は `~/.arefine/` に置く（「保存場所」を参照）
- normalize はルールベースで絞ってから LLM に渡す2段構え。1段目の結果は candidates.jsonl に置く（「処理の流れ」を参照）
- どのリポジトリでの会話か分からない発話は `_unknown/` にまとめ、減らす仕組みはいまは入れない（「保存場所」を参照）
- 外から読む JSON は zod で検証する。observation や refiner.yaml を外部の観点と共有するときに、`z.toJSONSchema` で形式を公開できるため
- AskUserQuestion への回答も候補に含める（「処理の流れ」を参照）
- 最初の観点の名前は `lint`。ディレクトリは `refiners/lint/`、config.yaml のキーも `lint` にする
- AGENTS.md・CLAUDE.md の各ルールに guidance ID を振る作業は M2 に含める
- LLM の呼び出し（normalize の2段目と観点の実行）には、ひとまず sonnet を使う。レポートの中身を見て変える
- 設定ファイル（config.yaml・refiner.yaml）は YAML で書く。手で直す設定なのでコメントを書けることを優先した。JSON はコメントを書けず、JSONC と TOML は YAML と同じく読み込みに依存が要るうえ、TOML は周りのツールで使う例が少ない。エディタの補完は、YAML でも `# yaml-language-server: $schema=…` で JSON Schema を指定すれば使える
- 1回の実行で LLM に使う金額の上限は、既定で1ドル。config.yaml の `budget_usd` で変えられる（「設定」を参照）
- リポジトリが分からない候補（`_unknown/`）は normalize しない（「処理の流れ」を参照）
- guidance ID は各リポジトリの AGENTS.md のルールに `[G-001]` の形で振る（「guidance ID の振り方」を参照）
- observation の `evidence` は M2 では持たず、M3 のセルフレビュー取り込みで足す（「observation の形式」を参照）
- セルフレビューの結果は `arefine observe` に JSON で渡し、`source: self-review` の observation にする。同じ結果を送り直しても重複しないよう、`id` は中身から作る（「セルフレビューの取り込み」を参照）
- 定期実行の頻度は既定で1日1回。config.yaml の `schedule` で `weekly` にも変えられる（「定期実行」を参照）
- 定期実行は launchd で行い、plist は `~/Library/LaunchAgents/arefine.run.plist`、出力は `~/.arefine/logs/run.log` に置く。登録は利用者が `launchctl bootstrap` で行う（「定期実行」を参照）
- collect と run は `~/.arefine/run.lock` で同時に1つしか動かさない（「定期実行」を参照）

## 未決事項

該当するマイルストーンまでに決める。

- normalize の2段目に、発話の直前に AI が何をしたかを渡すか。発話だけでは「違う、直して」のような指示の中身が分からない
- 完了ゲート menou を aRefine に入れるか、別リポジトリにするか
- 既定の観点のうち、スキル改善とコンテキストの入れ方の中身
- Issue / PR 出力に進む時期と、その前提になる提案の品質基準（M4、#4）
