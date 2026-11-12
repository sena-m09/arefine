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
3. dispatch：有効な観点ごとに、新しい observation を指示のまとまりに振り分けてから観点を実行する（`claude -p` または `codex exec`）
4. report：観点ごとの提案を Markdown のレポートにまとめる

normalize は2段で行う。1段目はルールベースで、人間が打った発話と AskUserQuestion への回答だけを候補として取り出し、`candidates.jsonl` に追記する。ツールの結果、hook が差し込んだ文、バックグラウンド処理の通知、サブエージェントへの依頼文、slash command は含めない。2段目は LLM で、候補から修正指示を選んで observation にする。ログの大半は人間の発話ではないので、1段目で LLM に渡す量を減らしてコストを抑えられる。

2段目は、候補を1件ずつ `claude -p` に渡し、修正指示を含むものだけを observation にして `observations.jsonl` に追記する。1つの発話に別々の指示があれば、指示ごとに observation を分ける。どこまで処理したかは、候補ごとに `progress.json` に記録する。LLM の呼び出しに失敗した候補は処理済みにしないので、次の実行でその候補からやり直す。observation の `id` は候補の `id` から決めるので、同じ候補を処理し直しても observation は重複しない。リポジトリが分からない候補（`_unknown/`）は、観点に渡しても提案の行き先がないので処理しない。

候補を1件ずつ渡すのは、まとめて渡すと、一緒に並んだ候補によって observation になるかどうかが変わるため。20 件まとめて渡していたときは、単独なら毎回拾われる候補が、並んだ相手との比較で落ちることがあった。同じ 20 件を同じ並びで5回渡すと 60 件中 58 件が5回とも同じ判定になり、回ごとの違いに見えていたものは、並びを変えるたびに相手が変わっていたためだった。手元の実際の候補 100 件を3回ずつ処理して比べると、次のようになった。「拾うべき」「拾わない」は処理する前に人が分けたもので、決め方を足す前後は、利用者が正解から外した1件を除いた 99 件で数えた。

| | 20 件ずつ | 5 件ずつ | 1 件ずつ | 1 件ずつ＋決め方を足したプロンプト（いま） |
| --- | --- | --- | --- | --- |
| 3回とも同じ判定だった候補 | 90/100 | 91/100 | 96/99 | 96/99 |
| 拾うべき 10 件の取りこぼし（3回の合計） | 6〜10/30 | 8/30 | 2/30 | 1/30 |
| 拾わない 84 件の拾いすぎ（3回の合計） | 2〜4/252 | 6/252 | 8/252 | 6/252 |
| `risk_kind` が3回とも同じ候補 | 99/100 | 98/100 | 97/99 | 99/99 |
| 50 件あたりの費用 | $0.05〜0.06 | $0.08 | $0.16〜0.22 | $0.15〜0.23 |

20 件ずつの数字は、5回分から3回を選んで数えた。1件ずつにすると、拾うか迷う候補もほぼ毎回拾う（迷うとした5件が3回とも拾われた）。迷う候補は拾う側でよいと利用者に確かめた。1回しか出ない指示は、件数の `threshold` に届かないので提案にならない。

1件ずつで増えた拾いすぎと、広く付きすぎた `outbound` は、プロンプトに決め方を足して抑えた。これからどうするかの相談や提案と、作業に入るのを待たせただけの発話は拾わない。「〜できるなら〜して」のような条件付きの頼み方は指示として拾う。`outbound` の決め方は「最初の観点：lint 化」に書いた。

費用は 20 件ずつの3〜4倍になる。呼び出しは1件ずつ順に行い、同時には呼ばない。順に呼ぶと1件あたり4秒ほどで、既定の `budget_usd`（1ドル）で処理できる 220〜330 件に 15〜20 分かかる。4件を同時に呼ぶと1件あたり1秒ほどに縮むが、費用は変わらず、時間の上限は `budget_usd` で決まっている。定期実行は人が待たずに動くので、1回の実行が 20 分ほどで終わるなら足りるとみた。同時に呼ぶと、上限に達したときに超える金額が同時に呼んだ分だけ増え、失敗した候補より先の候補が処理済みにならないよう進み具合の記録も工夫が要る。

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
  "stated_as_rule": false,
  "risk_kind": null,
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
  "stated_as_rule": false,
  "risk_kind": null,
  "evidence": { "violation": "const user = data as User;", "fix": "const user = User.parse(data);" },
  "ref": { "candidate": null, "session": "…", "log": null }
}
```

- `id`：セッションログからなら `obs_<候補の id>_<その候補の中での連番>`。セルフレビューからなら `obs_review_<ハッシュ>`（「セルフレビューの取り込み」を参照）
- `source`：`claude-session` / `codex-session` / `self-review` / `pr-review`
- `cwd`：発話したときの作業フォルダ。観点がリポジトリのファイルを読むときに使う
- `guidance_id`：normalize では `null` にする。どの guidance への指摘かは、AGENTS.md を読める観点の側で結びつける。セルフレビューが ID を引用していれば、それを入れる
- `summary`：指示の中身を「〜しない」「〜する」の形で書いた1文
- `stated_as_rule`：人が「今後は」「必ず」「二度と」「覚えておいて」「ルールにして」のように、これから先も守るルールとして言い切ったなら `true`。normalize の2段目で、発話の言い方から判定する。指示がどれだけ重要かでは判定しない。このフィールドがない古い行は `false` として読む。言い切りは人の発話の性質なので、セルフレビューからの observation は常に `false` にする
- `risk_kind`：AI がその指示に反したときに起きることの種類。`data-loss`（データや履歴が消える・書き換わる）、`leak`（秘密情報や外に出せない情報が手元の外に出る）、`outbound`（手元の外に反映・送信される）のどれかで、どれにも当たらなければ `null`。normalize の2段目で判定する（「最初の観点：lint 化」を参照）。このフィールドがない古い行は `null` として読む。セルフレビューからの observation は、元の発話がないので常に `null` にする
- `evidence`：違反したコード（`violation`）と、直したコード（`fix`、なければ `null`）。セルフレビューが渡したときだけ持つ。発話からは分からないので、セッションログからの observation には付けない
- `ref`：元の記録への参照。セルフレビューには元の候補とログがないので、`candidate` と `log` は `null`
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

- 必須なのは `session` と `findings`、`findings` の各要素の `summary` だけ。指摘がなければ `findings` は空でよい
- `cwd`：レビューしたリポジトリのフォルダ。省くと `arefine observe` を実行したフォルダになる。リポジトリは collect と同じく `git remote get-url origin` で求め、分からなければ何も追記せずに止める（`_unknown/` は run が処理しないので置かない）
- `session`：セルフレビューを回したセッションの ID
- `guidance_id`：引用した guidance ID（`G-006` の形）。対応するルールがなければ省く
- `evidence`：省いてよい。`fix` だけ省くこともできる

形が違えば、どの項目が違うかを示して止め、1件も追記しない。一部だけ追記すると、直して送り直したときに重複するため。

observation の `id` は、リポジトリ・`session`・`guidance_id`・`summary`・`violation` から作るハッシュにする。同じ結果を2回渡しても1件のままにし、別のセッションでの同じ指摘は別に数える。collect が同じ発話を重複して数えず、別のセッションで同じことを言ったものは別々に数えるのと揃えた。`session` を必須にしているのは、省けると別の日に来た同じ指摘が1件にまとまり、繰り返し出ている指摘を少なく数えてしまうため。

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
│   └── lint/
│       └── registry.json # 観点ごとの指示のまとまりと判定（「指示のまとまり」を参照）
└── reports/
    ├── 2026-11-06.md     # 日付ごとのレポート。同じ日の実行は追記する
    ├── index.jsonl       # レポートを書いた実行ごとの時刻・パス・提案の件数
    └── read.json         # どこまで読んだか（「提案を知らせる」を参照）
```

ほかの候補と見送った理由は次のとおり。

| 候補 | 見送った理由 |
| --- | --- |
| `~/.local/share/arefine/`（XDG） | macOS では見つけにくい |
| `~/.claude/plugins/data/<id>/`（`CLAUDE_PLUGIN_DATA`） | Claude Code 専用で、CLI 単体や Codex から使いにくい |
| `~/.agents/arefine/` | `~/.agents/` はスキル置き場の慣習で、データ置き場の取り決めがない |

### 定期実行

`arefine schedule` は、`arefine run` を launchd から定期実行するための plist を `~/Library/LaunchAgents/com.github.sena-m09.arefine.run.plist` に書き出し、登録と解除のコマンドを表示する。登録は利用者が自分で行う。

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.github.sena-m09.arefine.run.plist   # 登録
launchctl bootout gui/$(id -u)/com.github.sena-m09.arefine.run                                  # 解除
rm ~/Library/LaunchAgents/com.github.sena-m09.arefine.run.plist
```

- 頻度と時刻は config.yaml の `schedule` と `schedule_time` から plist を作るときに決まる。頻度や時刻を変えたときや Node を入れ替えたときは、`arefine schedule` をやり直し、bootout してから bootstrap し直す
- 時刻を決めて動かす（`StartCalendarInterval`）。時刻はそのマシンのローカル時刻で、スリープ中に過ぎた分は、起きたときに1回だけ動く
- launchd から起動すると PATH がほぼ空になり、`claude` と `git` が見つからない。そのため plist に、書き出したときの `PATH` と、設定されていれば `AREFINE_HOME`・`CLAUDE_CONFIG_DIR` を書く。Node と cli.ts も絶対パスで書くので、plist は使い続けるチェックアウトで書き出す
- 出力は `~/.arefine/logs/run.log` に追記する。各回の頭に日時の行を書く
- 失敗したときだけ macOS の通知を出す（下を参照）
- 普段の作業を止めないよう、`ProcessType: Background` と `LowPriorityIO` で優先度を下げる。launchd のジョブなので、失敗しても作業中のセッションには影響しない

plist は node を直接起動せず、`/bin/sh -c` で `arefine run --scheduled` を動かし、終了コードが 0 以外なら `osascript` の `display notification` で「定期実行が失敗しました。ログ: <run.log のパス>」と通知する。終了コードはそのまま launchd に返す。cli.ts の中で通知せず sh で包むのは、Node を入れ替えて plist の node のパスが古くなったときのように、cli.ts が動き出す前に落ちた場合も拾うため。そのかわり通知の本文に理由は入らないので、理由は run.log で見る。通知は依存を増やさないよう `osascript` で出す。本文は AppleScript の文字列に埋め込まず引数で渡し、パスに `"` が含まれても壊れないようにしている。通知をクリックしてもログは開かない。

失敗とみなすのは終了コードが 0 以外のときで、claude を起動できない、未ログインや使用上限で `claude -p` がエラーを返した、LLM の出力の形が違った、設定ファイルを読めなかった、がこれに当たる。lock で飛ばしたとき、`budget_usd` の上限で残りを次に回したときは 0 で終わるので通知しない。有効な観点がないときは、手で run したなら 0 で終わるが、`--scheduled` を付けた定期実行では 1 で終わり、通知する。定期実行を登録したまま観点を有効にしていないと、何もしない実行が誰にも気づかれずに続くため。形式を読めない発話があったときは run.log に警告を出すだけで、通知しない。

collect と run は、`~/.arefine/run.lock` で同時に1つしか動かないようにする。ロックを取れなかった実行は、何もせずに正常終了する。手で動かした run と定期実行が重なっても、候補や observation が二重にならないようにするため。ロックの中身は pid で、その pid のプロセスがもう動いていなければ、前の実行が途中で落ちた残りとみなして取り直す。observe は追記するだけなのでロックを取らない。

### 提案を知らせる

レポートは書くだけだと、自分で見に行かないと気づけない。提案は AGENTS.md やリンターの設定を直す話なので、そのリポジトリで作業を始めるときに見えるようにする。Claude Code のプラグイン（`plugin/claude-code/`）の SessionStart hook が、作業フォルダのリポジトリにまだ読んでいない提案があれば、件数とレポートのパスを知らせる。

どこまで読んだかは、リポジトリごとに時刻を1つだけ持つ。run はレポートを書くたびに `reports/index.jsonl` に `{ "at": "<実行の時刻>", "report": "<パス>", "proposals": <件数> }` を1行足す。`arefine ack` は、`reports/read.json` に `{ "read_until": "<時刻>" }` を書く。`at` が `read_until` より新しい行が、まだ読んでいない提案になる。

- レポートのファイル単位で既読にしないのは、同じ日の実行が同じファイルに追記されるため。ファイルを既読にすると、そのあとに足された提案が隠れる
- `read_until` には ack した時刻ではなく、index.jsonl のいちばん新しい `at` を書く。ack と同時に動いていた run の提案を、本人が見る前に既読にしないため
- run は index.jsonl に追記するだけ、ack は read.json を書くだけなので、2つが同じファイルを書き換えない。ack はロックを取らない
- 提案1件ずつは既読にしない。取り入れたかどうかは registry.json の `resolved_at` で別に測っている

既読にするのは、利用者が `arefine ack` を実行したときだけ。リポジトリのフォルダで実行するとそのリポジトリの提案をすべて既読にし、`--repo owner/name` でも指定できる。知らせた時点で既読にすると、別の作業で開いたセッションで見落としたときに二度と出ず、worktree を並べて開くと最初の1つで消えてしまう。レポートを開いたことは、エディタで開いた場合を含めて知る手段がない。

hook は次のように動く。

- 新規の起動と再開（matcher `startup|resume`）のときだけ動く。`/clear` や compact では出さない
- 入力の `cwd` に対して `git remote get-url origin` を1回呼び、collect と同じ規則で owner/repo を求める。gh は使わない。worktree でも origin が同じなので、元のリポジトリと同じ提案が出る
- 利用者向けの `systemMessage` に「<owner/repo> にまだ読んでいない提案が N 件あります」、新しいものから3つまでのレポートのパス、`arefine ack` の案内を出す。Claude 向けの `additionalContext` にも同じ件数とパスを渡し、利用者に聞かれたときだけ触れ、読み終えたと言われたら `arefine ack` を実行するよう添える。`claude -p` で確かめると、`additionalContext` は Claude のコンテキストに入り、`systemMessage` は入らなかった
- git のフォルダでない、origin がない、提案がない、すべて読んだ、のどれかなら何も出さない。どこで失敗しても何も出さずに終了コード 0 で終わり、セッションの開始を妨げない
- LLM は呼ばない。git の呼び出しと小さなファイル2つの読み込みだけで、手元では 60〜100ms で終わる。timeout は 5 秒にしている

hook は依存のない単体の TypeScript で書き、Node の型の除去でそのまま動かす。プラグインはインストールすると `~/.claude/plugins/cache/` にコピーされ、同じリポジトリの `packages/core` を読み込めないため。そのぶん、owner/repo の求め方と index.jsonl・read.json の読み方をコアと hook の2か所に持つことになる。片方だけ直して hook が黙って何も出さなくならないよう、remote の URL の例（`packages/core/test/fixtures/remote-urls.json`）を両方のテストで使い、コアの `writeReport` と `arefine ack` が書いたファイルを hook に読ませるテストを置いている。hook では zod を使えないので、形を手で確かめ、読めない行は数えない。

知らせる文面は `arefine ack` をそのまま載せるので、`arefine` が PATH にあることを前提にする（README を参照）。

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

dispatch は、観点ごとに2回 `claude -p` を呼ぶ。1回目で、まだ渡していない observation（最大100件）を指示のまとまりに振り分ける（「指示のまとまり」を参照）。2回目は `SKILL.md` をシステムプロンプトにして観点を実行し、今回 observation が入ったまとまりと判定済みのまとまり、今回入った observation、config.yaml にあるその観点の設定を渡す。observation の `source` が観点の `inputs` にないものは渡さない。発話の `cwd` が残っていれば、そこを作業フォルダにして Read・Grep・Glob だけを使えるようにする。観点はリポジトリの AGENTS.md やリンターの設定を読めるが、ファイルは書き換えられない。

観点が守る約束：

- 出力は、判定の一覧（`judgments`）、提案が取り入れられたと確かめたまとまり（`resolved`）、提案の一覧（`proposals`）
- 判定には、まとまりの id、対応する guidance ID、取り入れられたかを次の判定で確かめられるか（`trackable`）、観点が次の判定で使う記録（`state`）を含める。コアは `state` の中身を読まずに registry.json に保存し、次の実行でそのまま観点に渡す
- 各提案にタイトル（`title`）、根拠になったまとまりの id（`groups`）、Markdown で書いた変更案（`change`）を含める。コアがこれを `reports/<日付>.md` にまとめ、根拠にはまとまりに入っている observation の id を前の実行の分も含めて載せる
- 観点は自分でファイルを書けないので、状態は判定の `state` に入れて返す（コアの observations.jsonl は書き換えない）
- 既定の観点もすべて `default_enabled: false`。使う人が明示的に有効化する

振り分けと観点の実行のどちらかに失敗したら、どちらの結果も残さず、次の実行で同じ observation から振り分け直す。

### 指示のまとまり

観点は「同じ指示が何回出たか」で提案するかを決めるが、1日1件ずつ出る指示は、1回の実行の中で数えると永遠に `threshold` に届かない。そのため、中身が同じ指示の observation を、実行をまたいで「指示のまとまり」に集め、観点ごとに `<owner>__<repo>/refiners/<観点>/registry.json` に残す。

```json
{
  "groups": [
    {
      "id": "I-001",
      "summary": "コンポーネントで fetch を直接呼ばない",
      "guidance_id": null,
      "observation_ids": ["obs_1f0c…_1", "obs_7a2e…_1", "obs_review_a7ca…"],
      "judged_at": "2026-11-06T03:00:00.000Z",
      "count_at_judgment": 3,
      "trackable": true,
      "resolved_at": null,
      "state": { "result": "existing-rule", "reason": "…", "rule": "<リンター名>: <ルール名>", "linters": { "<リンター名>": "<version>" } }
    }
  ],
  "unassigned": []
}
```

- `id`：コアが `I-001` から連番で振る
- `summary`：指示の中身を「〜する」「〜しない」の形で書いた1文。振り分けのときに LLM が書く
- `guidance_id`：観点が判定のときに AGENTS.md と照らし合わせて入れる。セッションログからの observation は guidance ID を持たないので、まとまりの鍵には使わない
- `observation_ids`：まとまりに入った observation。件数はコアがここから数える
- `judged_at`・`count_at_judgment`：観点が最後に判定した日時と、そのときの件数。観点が判定を返したときにコアが書く
- `trackable`・`resolved_at`：提案が取り入れられたかを確かめる対象か、取り入れを確かめた日時（「最初の観点：lint 化」を参照）
- `state`：観点の判定の記録。コアは中身を読まない
- `unassigned`：振り分けに失敗した observation。次の実行でもう一度振り分ける

振り分けは、観点の実行とは別の `claude -p`（sonnet）で行う。既存のまとまりの id・1文・件数と、新しい observation の `summary` を渡し、既存のまとまりに入れるか、新しいまとまりを作るかを返させる。observation は id でなく `o1` のような短い key で渡し、コアが元の id に戻す。返ってきた key やまとまりの id が入力にないもの、振り分けの漏れは `unassigned` に回す。

すでにまとまりに入っている observation は、読み直しても振り分け直さない。registry.json を書いてから dispatch の位置を進めるので、その間で止まっても同じ observation が2回数えられない。registry.json がないときは、dispatch の位置を無視して observations.jsonl を最初から振り分ける。M2 で観点に渡し終えた observation も、これでまとまりに入る。

振り分けの誤り（違う指示を同じまとまりに入れる、同じ指示で別のまとまりを作る）は自動では直らない。気づいたら registry.json を手で直す。

### 設定

| 置き場所 | 用途 |
| --- | --- |
| `~/.arefine/config.yaml` | ユーザー単位。観点の有効化、自作観点の追加、定期実行の頻度と時刻 |
| `<repo>/.arefine/config.yaml` | プロジェクト単位。ユーザー設定を上書きする（プロジェクト導入後） |

```yaml
budget_usd: 1
refiners:
  lint:
    enabled: true
    threshold: 3
    rejudge_after: 3
  skills:
    enabled: false
custom_refiners:
  - ~/dev/my-refiners/context
schedule: weekly
schedule_time: "08:30"
```

`budget_usd` は1回の実行で LLM に使ってよい金額の上限（ドル）で、既定は1。`schedule` は定期実行の頻度で、`daily`（毎日、既定）か `weekly`（毎週月曜）。`schedule_time` は動かす時刻で、`"08:30"` や `"8:30"` のように 0:00〜23:59 で書き、既定は 3:00。`enabled` 以外の観点の設定は、コアは読まずにそのまま観点に渡す。

1回の実行で使った LLM の費用を足し合わせ、上限に達したらそれ以降の呼び出しを始めない。処理しきれなかった候補と observation は次の実行に回す。上限に達する直前の呼び出しは最後まで実行するので、使う金額は上限を1回分の呼び出し（数セント）ほど超えることがある。`claude -p` の `--max-budget-usd` には残りの金額ではなく上限そのものを渡し、1回の呼び出しが上限を超えて続いたときの歯止めにだけ使う。`--max-budget-usd` は超えた時点で結果を捨てて止めるので、残りの金額を渡すと、上限の直前の呼び出しが費用だけかかって結果を残さない。

既定で同梱する観点の候補は、lint 化・スキル改善・コンテキストの入れ方の3つ。最初は lint 化だけを実装する。

## 最初の観点：lint 化

人間が繰り返し指摘した guidance について、「既存ルールで強制できる」「自作ルールなら可能」「機械判定できない」のどれかを判定し、lint 化の提案を出す。観点の名前は `lint`。

- 判定のタイミング：同じ指示のまとまりに修正指示が N 件以上溜まったとき、セルフレビューで guidance 違反を指摘したとき、定期実行のとき
- guidance ID：AGENTS.md / CLAUDE.md の各ルールに `[G-012]` のような見える ID を付け、セルフレビューが ID を引用して違反を報告できるようにする（「guidance ID の振り方」を参照）
- 判定の手順：既存リンタールールを探す → 違反例と修正例（observation の `evidence.violation` / `evidence.fix`）をテストケースにして自作ルールを試作する → テストに通らなければ棄権して「機械判定不可」とする
- 重さの配分：セルフレビュー時は既存ルールの探索まで。自作ルールの試作は定期実行でまとめて行う
- 状態：指示のまとまりごとの判定を registry.json の `state` に残す（「指示のまとまり」を参照）。`state` は `result`（`existing-rule` / `custom-rule` / `not-mechanizable`）・`reason`・`rule`（提案したルール名）・`linters`（判定したときのリンターの version）を持つ
- 判定するのは、まだ判定していないまとまりで件数が `threshold`（既定 3）以上になったか、`stated_as_rule` が `true` か `risk_kind` が `null` でない observation が入ったときと、判定済みのまとまりで件数が `count_at_judgment` から `rejudge_after`（既定 3）件以上増えたか、リンターの version が変わったときだけ
- 判定したまとまりだけを提案にする。一度提案した指示を、件数が増えるたびに毎回提案し直さないため
- ローカル段階では提案を置くだけで、プロジェクトには自動適用しない

再判定の条件は観点の設定なので、コアは判定し直すかどうかを決めず、件数と前回の判定を観点に渡して決めさせる。リンターの version は観点が `node_modules/<パッケージ名>/package.json` から読む。新しい observation がない実行では観点を呼ばないので、version が変わったことに気づくのは、そのリポジトリで次に observation が増えたときになる。

人がルールとして言い切った指示（`stated_as_rule` が `true`）は、件数が `threshold` に届かなくても判定して提案にする。言い切った指示は1回しか出ていなくても重いことが多いため。指示がどれだけ重要かを LLM に採点させるとぶれやすいので、発話の言い方から判定できる言い切りを根拠にする。

言い切っていなくても、取り返しのつかない操作や情報の漏れにつながる指示（`risk_kind` が `null` でない）は、件数が `threshold` に届かなくても判定して提案にする。「待って、そこは共有のブランチだよ」のように止めただけの指示は、言い切りでは拾えないため。重さの度合いは LLM に聞かず、指示が扱う操作が次の3種類のどれに当たるかだけを選ばせる。

| 種類 | 当たるもの |
| --- | --- |
| `data-loss` | ファイルやフォルダの削除、`git reset --hard`、未コミットの変更を捨てる、force push（自分のブランチへのものも含む）、push 済みの履歴の書き換え、DB のデータの削除や上書き |
| `leak` | トークン・鍵・`.env` の中身、別のリポジトリや顧客の名前、生のログを、コミット・投稿・外部のサービスに含める |
| `outbound` | push・merge、本番へのデプロイ、本番の DB に向けたコマンド、パッケージの publish、Slack への投稿、issue や PR へのコメント、メールの送信 |

- 2つ以上に当たるときは `data-loss`・`leak`・`outbound` の順に見て、最初に当たったものにする。共有ブランチへの force push は `data-loss` になる
- 手元の外に出す前に人の承認を求める指示（見せてから投稿する、OK をもらってから PR を作る など）は `outbound` にする。テストや lint を通してから push するような品質の確認は `null` にする
- 手元の外に出す操作を、誰の名前やどのアカウントで行うかの指定は `outbound` にする。違うアカウントで出してしまうと取り消しにくく、1回出ただけでも提案にしてほしいと利用者に確かめた
- 手元の外に出すものの分け方・まとめ方・書き方の指定と、その作業のあいだだけ送信や投稿を控えさせる指定は `null` にする。候補を1件ずつ渡すとこれらにも `outbound` が付いたが、利用者に確かめると、何度か出てから提案になれば足りる指示だった
- リポジトリの中のコードやドキュメントの編集は `data-loss` に入れない。git で戻せ、入れると大半の指示に印が付くため
- 自分のブランチへの force push を `data-loss` に入れるのは、発話からは共有のブランチかどうかが分からないことが多いため
- 「取り返しがつくか」を LLM に問う形にしなかったのは、どこまで戻せたら戻せるとするかを毎回 LLM が決めることになり、度合いの採点と同じようにぶれるため
- 判定は観点でなく normalize で行う。観点に渡すのは observation の `summary` で、「共有の」のような元の発話の文脈は残っていないことがあるため。どの種類の操作についての指示かは指示そのものの性質なので、observation に持たせても観点に依存しない
- registry.json には何も足さない。印の付いた observation が入ったまとまりは、言い切りと同じく判定済みのまとまりになり、どの理由で判定したかはレポートの提案に書く。判定済みのまとまりにあとから印の付いた observation が入っても、判定し直す条件は変えない

判定が揃うかは、正解を決めた架空の候補 35 件と、手元の実際の候補 50 件で確かめた。どちらも回ごとに順番を混ぜ直して5回 normalize し、候補ごとに種類（どれにも当たらなければ none）を比べた。揃っているとみなす基準は、正解が重い候補は5回とも同じ種類になること、重くない候補は印が付くのが5回中1回までであること。1回しか出ない重い指示を見逃すと拾い直す機会がないので、見逃しのほうを厳しく見た。

- 架空の候補は、35 件すべてが基準を満たした。初めは「待って」と止めただけの発話が observation にならないことがあり、承認と品質の確認の線引きもプロンプトの例と食い違っていた。どちらもプロンプトを直してから測り直した。5回流す費用は $0.2 ほど
- 実際の候補は、50 件中 49 件が5回とも同じ種類になった。印が付いたのは2件で、利用者に確かめてもらうと、5回とも `data-loss` だった1件は気をつけてほしい指示、5回中1回だけ `outbound` だった1件は重くない指示だった。どちらも基準の内に収まった

候補を1件ずつ渡すように変え、プロンプトに決め方を足したあとで、同じ架空の候補 35 件を1件ずつ3回、実際の候補 100 件を1件ずつ3回処理して測り直した。

- 架空の候補は、35 件中 34 件が基準を満たした（3回に当てはめ、重くない候補は印が付くのが3回中1回まで）。満たさなかった1件は、本番の環境変数を書き換えるコマンドを止めた発話で、正解は `outbound` だが3回とも `data-loss` になった。決め方を足す前のプロンプトで1件ずつ渡すと3回とも `outbound` だったので、足した文面で変わったことになる。どちらの種類でも提案にはなり、「書き換わる」を `data-loss` と読むのも一覧の文面に沿っているので、そのままにした。止めた発話は、操作を止めた4件が3回とも observation になった
- 実際の候補は、99 件すべてが3回とも同じ種類になった。印が付いたのは3件で、どれも3回とも同じだった。force push の指示が `data-loss`、アカウントの指定を含む2件が `outbound` で、利用者の答えと合っている。`outbound` にしないと決めた2件には、3回とも印が付かなかった

今回 observation が入ったが、まだ一度も判定していないまとまりは、レポートの「様子を見る指示」に一覧で載せる。判定済みで判定し直さなかったまとまりは載せない。

lint 化できた割合は、提案が取り入れられたかで測る。`existing-rule` と判定し、そのルールがまだリンターの設定で有効になっていないまとまりだけを `trackable` にする。次にそのリポジトリで観点を呼んだとき、`state.rule` のルールが有効になっていれば、観点が `resolved` で返し、コアが `resolved_at` を書く。コアは、判定したまとまりの数と、`trackable` のうち `resolved_at` があるものの割合をレポートに出す。`custom-rule` は M4 でルールのファイルを作るまで確かめられないので、`trackable` にしない。

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
├── .claude-plugin/
│   └── marketplace.json      # plugin/claude-code を配る marketplace
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
│   ├── claude-code/          # plugin.json、hook（SessionStart で未読の提案を知らせる）
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
- normalize の2段目は、候補を1件ずつ LLM に渡す。まとめて渡すと、一緒に並んだ候補によって observation になるかどうかが変わるため。費用は3〜4倍になる。呼び出しは順に行い、同時には呼ばない（「処理の流れ」を参照）
- 1回の実行で LLM に使う金額の上限は、既定で1ドル。config.yaml の `budget_usd` で変えられる（「設定」を参照）
- リポジトリが分からない候補（`_unknown/`）は normalize しない（「処理の流れ」を参照）
- guidance ID は各リポジトリの AGENTS.md のルールに `[G-001]` の形で振る（「guidance ID の振り方」を参照）
- observation の `evidence` は M2 では持たず、M3 のセルフレビュー取り込みで足す（「observation の形式」を参照）
- セルフレビューの結果は `arefine observe` に JSON で渡し、`source: self-review` の observation にする。同じ結果を送り直しても重複しないよう、`id` は `session` を含む中身から作り、`session` は必須にする（「セルフレビューの取り込み」を参照）
- 定期実行の頻度は既定で1日1回。config.yaml の `schedule` で `weekly` にも変えられる（「定期実行」を参照）
- 定期実行の時刻は既定で 3:00。`schedule` を頻度と時刻の組に広げず、`schedule_time` という別のキーにする。`schedule: daily` だけの設定ファイルをそのまま読め、時刻を誤ったときのエラーにもキー名が出るため。weekly の曜日は月曜のままにし、選べるようにはしない。曜日を変えたいという必要がまだ出ていないため（「設定」を参照）
- 定期実行は launchd で行う。Label はほかの人に配る前提で、ほかのジョブと名前がぶつからない逆ドメインの形 `com.github.sena-m09.arefine.run` にする。plist は `~/Library/LaunchAgents/com.github.sena-m09.arefine.run.plist`、出力は `~/.arefine/logs/run.log` に置く。登録は利用者が `launchctl bootstrap` で行う（「定期実行」を参照）
- collect と run は `~/.arefine/run.lock` で同時に1つしか動かさない（「定期実行」を参照）
- 人がルールとして言い切った指示は、件数が `threshold` に届いていなくても lint 観点が提案にする。言い切りかどうかは normalize で observation の `stated_as_rule` に残す（「最初の観点：lint 化」を参照）
- 言い切っていなくても、取り返しのつかない操作や情報の漏れにつながる指示は、件数が `threshold` に届いていなくても lint 観点が提案にする。どの種類に当たるかは、normalize で observation の `risk_kind` に、3種類の一覧から選ばせて残す。架空の候補と手元の実際の候補をそれぞれ5回処理し直し、判定が揃うことを確かめた（「最初の観点：lint 化」を参照）
- 観点の件数は、中身が同じ指示の observation を実行をまたいで集めた「指示のまとまり」で数える。guidance ID はセッションログからの observation が持たないので、鍵にしない（「指示のまとまり」を参照）
- まとまりへの振り分けは、観点の実行とは別の sonnet の呼び出しで行う。手元の observation で測ると、別に呼べば言い換えの組 16 組をすべて同じまとまりに入れられた。観点の実行と同じ呼び出しで振り分けさせると、1回しか出ていない指示 40 件を「その他」の1つのまとまりに入れてしまった。haiku は sonnet より速くならず、出力の形を誤ることと、別の指示を1つにまとめすぎることがあった
- registry.json はコアが書く。まとまりと件数はコアが持ち、観点の判定は `state` として中身を読まずに預かる。観点は Read・Grep・Glob しか使えず、件数の足し算を LLM に任せるとずれるため（「観点の仕様と設定」を参照）
- lint 化できた割合は、次の判定のときにリンターの設定で提案したルールが有効になっているかで測る（「最初の観点：lint 化」を参照）
- 提案は、Claude Code のプラグインの SessionStart hook で、そのリポジトリで作業を始めるときに知らせる。どこまで読んだかはリポジトリごとの時刻1つで持ち、既読にするのは `arefine ack` だけ（「提案を知らせる」を参照）
- SessionStart hook はプラグインの中で単体で動く TypeScript にし、コアを読み込まない。プラグインは GitHub の marketplace から入れ、cache にコピーされて動くため。形のずれは、コアと hook が同じフィクスチャを使うテストで防ぐ（「提案を知らせる」を参照）
- `arefine` は PATH に入れて使う前提にし、知らせる文面に `arefine ack` をそのまま載せる
- 定期実行が失敗したときだけ、macOS の通知を `osascript` で出す。plist から sh 経由で起動して終了コードを見るので、Node が見つからない場合も拾える。本文は「失敗しました。ログ: …」だけ。有効な観点がないまま定期実行が動いたときは、定期実行のときだけ失敗とする（「定期実行」を参照）
- 観点の状態は SQLite にせず JSON のままにする。observation は年に数千行、registry.json は指示の数だけと量が小さく、検索の速さは問題にならない。手で読めて grep でき、観点ごとの状態をリポジトリのフォルダに持つ作りとも合う。難しいのは検索の速さではなく、新しい指示が前のどの指示と同じかを決めることで、SQLite にしても解決しない。複数リポジトリの横断集計、埋め込みを使った検索、ファイルが数十 MB になったときに見直す

## 未決事項

該当するマイルストーンまでに決める。

- normalize の2段目に、発話の直前に AI が何をしたかを渡すか。発話だけでは「違う、直して」のような指示の中身が分からない。`risk_kind` の判定にも効く。「待って、そこは共有のブランチだよ」は、AI が push しようとしていたと分からないと、何をしない指示なのかが決まらない
- 完了ゲート menou を aRefine に入れるか、別リポジトリにするか
- 既定の観点のうち、スキル改善とコンテキストの入れ方の中身
- Issue / PR 出力に進む時期と、その前提になる提案の品質基準（M4、#4）
- 指示のまとまりへの振り分けを誤ったときに直す手段。いまは registry.json を手で直す
- normalize の2段目で、候補を1件ずつ渡しても、observation になるかどうかが回によって変わる候補が残る。手元の実際の候補 99 件を3回処理すると、3件が回によって変わった。長い依頼文に指定が混じった発話では、1つの発話から出る observation の数も回によって変わる（3回とも拾われた 15 件のうち4件）。複数回処理して多数決を取るか（#23）は決めていない
- normalize の呼び出しを同時に行うか。たまった候補を初めて処理するときは、1ドル分に 15〜20 分かかる。待ち時間が問題になったら見直す
- 取り返しのつかない操作を止める指示を、AGENTS.md やリンターでなく、Claude Code の permissions や git の hook で止める提案にするか
