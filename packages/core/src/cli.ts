#!/usr/bin/env node
import { parseArgs } from "node:util";

const USAGE = `arefine - コーディングエージェントのセッションログから人間の指摘を拾い、改善提案を出す

使い方:
  arefine <command> [options]

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
} else {
  process.stderr.write(`不明なコマンドです: ${command}\n使えるコマンドは arefine --help で確認してください。\n`);
  process.exitCode = 1;
}
