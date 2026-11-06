#!/usr/bin/env node
import { parseArgs } from "node:util";
import { collect } from "./pipeline/collect.ts";

const USAGE = `arefine - コーディングエージェントのセッションログから人間の指摘を拾い、改善提案を出す

使い方:
  arefine <command> [options]

コマンド:
  collect        セッションログの新しい分から人間の発話を取り出し、候補として保存する

オプション:
  -h, --help     この使い方を表示する
`;

const { values, positionals } = parseArgs({
  options: { help: { type: "boolean", short: "h" } },
  allowPositionals: true,
  strict: false,
});

const [command] = positionals;

if (values.help || command === undefined) {
  process.stdout.write(USAGE);
} else if (command === "collect") {
  try {
    const { logs, candidates, unreadable } = collect(process.env);
    process.stdout.write(`${logs} 件のセッションログから ${candidates} 件の発話を取り出しました。\n`);
    if (unreadable > 0) {
      process.stderr.write(
        `人間の発話のうち ${unreadable} 件は形式を読めず、取り出していません。\nClaude Code のログ形式が変わった可能性があります。sources/claude-code.ts のスキーマを確認してください。\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`不明なコマンドです: ${command}\n使えるコマンドは arefine --help で確認してください。\n`);
  process.exitCode = 1;
}
