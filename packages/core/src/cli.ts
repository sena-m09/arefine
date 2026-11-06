#!/usr/bin/env node
import { parseArgs } from "node:util";
import { configFile } from "./config/config.ts";
import { arefineHome } from "./config/paths.ts";
import { claudeLlm } from "./llm/claude.ts";
import { collect } from "./pipeline/collect.ts";
import type { CollectSummary } from "./pipeline/collect.ts";
import { run } from "./pipeline/run.ts";
import type { RunSummary } from "./pipeline/run.ts";

const USAGE = `arefine - コーディングエージェントのセッションログから人間の指摘を拾い、改善提案を出す

使い方:
  arefine <command> [options]

コマンド:
  collect        セッションログの新しい分から人間の発話を取り出し、候補として保存する
  run            collect のあと、候補から修正指示を拾い、有効な観点の提案をレポートにまとめる

オプション:
  --repo <owner/name>  run で処理するリポジトリを1つに絞る。git remote の origin と同じ名前で指定する
  -h, --help           この使い方を表示する
`;

const { values, positionals } = parseArgs({
  options: { help: { type: "boolean", short: "h" }, repo: { type: "string" } },
  allowPositionals: true,
  strict: false,
});

const [command] = positionals;

if (values.help || command === undefined) {
  process.stdout.write(USAGE);
} else if (command === "collect") {
  guard(() => printCollected(collect(process.env)));
} else if (command === "run" && values.repo !== undefined && typeof values.repo !== "string") {
  process.stderr.write("--repo には owner/name の形でリポジトリを指定してください。\n");
  process.exitCode = 1;
} else if (command === "run") {
  const repo = typeof values.repo === "string" ? values.repo : undefined;
  guard(() => printRun(run(process.env, { llm: claudeLlm, now: new Date(), ...(repo === undefined ? {} : { repo }) })));
} else {
  process.stderr.write(`不明なコマンドです: ${command}\n使えるコマンドは arefine --help で確認してください。\n`);
  process.exitCode = 1;
}

function guard(action: () => void): void {
  try {
    action();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function printCollected({ logs, candidates, unreadable }: CollectSummary): void {
  process.stdout.write(`${logs} 件のセッションログから ${candidates} 件の発話を取り出しました。\n`);
  if (unreadable > 0) {
    process.stderr.write(
      `人間の発話のうち ${unreadable} 件は形式を読めず、取り出していません。\nClaude Code のログ形式が変わった可能性があります。sources/claude-code.ts のスキーマを確認してください。\n`,
    );
  }
}

function printRun(summary: RunSummary): void {
  printCollected(summary.collected);
  for (const name of summary.missing) {
    process.stderr.write(`config.yaml で有効にした観点 ${name} が見つかりません。名前と custom_refiners を確認してください。\n`);
  }
  if (summary.refiners.length === 0) {
    process.stdout.write(
      `有効な観点がないため、ここで止めました。\n${configFile(arefineHome(process.env))} で観点を有効にしてください（例: refiners: { lint: { enabled: true } }）。\n`,
    );
    return;
  }
  if (summary.repoNotFound !== null) {
    const { requested, known } = summary.repoNotFound;
    process.stderr.write(
      `${requested} での会話が見つかりません。git remote の origin と同じ owner/name で指定してください。\n会話が見つかっているリポジトリ:\n${known.map((name) => `  ${name}`).join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  for (const { repo, normalize, dispatch, report } of summary.repos) {
    if (normalize.candidates > 0) {
      process.stdout.write(`${repo}: ${normalize.candidates} 件の発話から ${normalize.observations} 件の修正指示を拾いました。\n`);
    }
    for (const result of dispatch.filter((result) => result.observations > 0)) {
      process.stdout.write(`${repo}: 観点 ${result.refiner} が ${result.proposals.length} 件の提案を出しました。\n`);
    }
    if (report !== null) {
      process.stdout.write(`  レポート: ${report}\n`);
    }
    for (const error of [normalize.error, ...dispatch.map((result) => result.error)].filter((error) => error !== null)) {
      process.stderr.write(`${repo}: ${error}\n次の実行でやり直します。\n`);
      process.exitCode = 1;
    }
  }

  process.stdout.write(`LLM の費用: $${summary.spentUsd.toFixed(3)}（上限 $${summary.budgetUsd}）\n`);
  const pending = summary.repos.reduce(
    (sum, repo) => sum + repo.normalize.pending + repo.dispatch.reduce((total, result) => total + result.pending, 0),
    0,
  );
  if (pending > 0) {
    process.stdout.write(`残りの ${pending} 件は次の実行で処理します。\n`);
  }
}
