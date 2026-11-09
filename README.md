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

定期実行にするときは `arefine schedule` を実行し、表示された `launchctl bootstrap` のコマンドで登録してください。定期実行が失敗したときは、macOS の通知に「定期実行が失敗しました。ログ: …」と出ます。理由はそのログで確かめてください。

## 提案をセッションの開始時に知らせる

Claude Code のプラグインを入れると、まだ読んでいない提案があるリポジトリでセッションを始めたときに、件数とレポートのパスを知らせます。Claude Code の中で次を実行してください。

```
/plugin marketplace add sena-m09/arefine
/plugin install arefine@arefine
```

プラグインは、Claude Code から見える PATH の `node` で動きます。その `node` も Node 24 以上にしてください。古いと、セッションを始めるたびに hook のエラーが出ます。

提案を読み終えたら、そのリポジトリのフォルダで `arefine ack` を実行してください。そのリポジトリの提案をすべて読んだことにして、次からは知らせなくなります。別のフォルダから実行するときは、`arefine ack --repo owner/name` でリポジトリを指定します。

`arefine ack` を実行するまでは、そのリポジトリでセッションを始めるたびに知らせます。`/clear` や compact のあとには知らせません。
