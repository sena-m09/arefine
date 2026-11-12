# aRefine

コーディングエージェントのセッションログから、人間が AI に出した修正の指示を拾い、AGENTS.md やリンターの設定をどう直すかの提案を出すツールです。いまは Claude Code のセッションログに対応しています。

設計の詳細は [docs/design.md](docs/design.md) にあります。

## 必要なもの

- Node 24 以上
- [bun](https://bun.sh/)（依存のインストールに使います）
- Claude Code（`claude` コマンド。提案を作るときに `claude -p` を呼びます）

## インストール

リポジトリを取ってきて、依存を入れます。

```sh
git clone https://github.com/sena-m09/arefine.git
cd arefine
bun install
```

`arefine` コマンドを PATH の通ったフォルダに置きます。CLI はビルドせずに .ts のまま動くので、`packages/core/src/cli.ts` へのシンボリックリンクを作ります。次の例は `~/.local/bin` が PATH に入っている場合です。

```sh
ln -s "$PWD/packages/core/src/cli.ts" ~/.local/bin/arefine
arefine --help
```

チェックアウトを別の場所に動かしたときは、リンクを作り直してください。

## 使い方

`~/.arefine/config.yaml` で観点を有効にします。観点はすべて既定で無効です。

```yaml
refiners:
  lint:
    enabled: true
```

`arefine run` を実行すると、セッションログの新しい分を読み、提案を `~/.arefine/<owner>__<repo>/reports/<日付>.md` に書きます。

発話は1件ずつ LLM で判定するので、初めて実行するときは、たまっているセッションログの分だけ時間と費用がかかります。1回の実行で使う金額の上限は既定で1ドルで、発話 220〜330 件ほどを 15〜20 分で処理します。上限に達したら残りは次の実行に回り、続きから処理します。レポートが出るのは、そのリポジトリの発話を処理し終えた実行からです。早く出したいときは、`arefine run` を繰り返すか、config.yaml で上限を一時的に上げてください。`--repo owner/name` を付けると、そのリポジトリだけを先に処理できます。

```yaml
budget_usd: 5  # 1回の実行で LLM に使う金額の上限（ドル）
```

定期実行にするときは `arefine schedule` を実行し、表示された `launchctl bootstrap` のコマンドで登録してください。既定では毎日 3:00 に動きます。頻度と時刻は config.yaml で変えられます。

```yaml
schedule: weekly        # daily（毎日）か weekly（毎週月曜）
schedule_time: "08:30"  # そのマシンの時刻で 0:00〜23:59
```

頻度や時刻を変えたら、`arefine schedule` をもう一度実行し、表示された `launchctl bootout` と `launchctl bootstrap` で登録し直してください。

定期実行が失敗したときは、macOS の通知に「定期実行が失敗しました。ログ: …」と出ます。理由はそのログで確かめてください。

## 提案をセッションの開始時に知らせる

Claude Code のプラグインを入れると、まだ読んでいない提案があるリポジトリでセッションを始めたときに、件数とレポートのパスを知らせます。Claude Code の中で次を実行してください。

```
/plugin marketplace add sena-m09/arefine
/plugin install arefine@arefine
```

プラグインは、Claude Code から見える PATH の `node` で動きます。その `node` も Node 24 以上にしてください。古いと、セッションを始めるたびに hook のエラーが出ます。

提案を読み終えたら、そのリポジトリのフォルダで `arefine ack` を実行してください。そのリポジトリの提案をすべて読んだことにして、次からは知らせなくなります。別のフォルダから実行するときは、`arefine ack --repo owner/name` でリポジトリを指定します。

`arefine ack` を実行するまでは、そのリポジトリでセッションを始めるたびに知らせます。`/clear` や compact のあとには知らせません。
