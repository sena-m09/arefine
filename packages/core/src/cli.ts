#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configFile, loadConfig } from "./config/config.ts";
import { arefineHome, repoDir } from "./config/paths.ts";
import { claudeLlm } from "./llm/claude.ts";
import { collect } from "./pipeline/collect.ts";
import type { CollectSummary } from "./pipeline/collect.ts";
import { withLock } from "./pipeline/lock.ts";
import type { Locked } from "./pipeline/lock.ts";
import { observe } from "./pipeline/observe.ts";
import { resolveRepo } from "./pipeline/repo.ts";
import { run } from "./pipeline/run.ts";
import type { RunProgress, RunSummary } from "./pipeline/run.ts";
import { markRead } from "./pipeline/unread.ts";
import { LABEL, writePlist } from "./schedule/launchd.ts";

const USAGE = `arefine - コーディングエージェントのセッションログから人間の指摘を拾い、改善提案を出す

使い方:
  arefine <command> [options]

コマンド:
  collect        セッションログの新しい分から人間の発話を取り出し、候補として保存する
  run            collect のあと、候補から修正指示を拾い、有効な観点の提案をレポートにまとめる
  observe        セルフレビューの結果（JSON）を標準入力から受け取り、修正指示として追記する
  schedule       run を launchd から定期実行するための plist を書き出し、登録と解除の手順を表示する
  ack            いまいるリポジトリの提案を、すべて読んだことにする。セッションの開始時に知らせなくなる

オプション:
  --repo <owner/name>  run で処理するリポジトリ、ack で読んだことにするリポジトリを1つに絞る。git remote の origin と同じ名前で指定する
  -h, --help           この使い方を表示する
`;

const { values, positionals } = parseArgs({
  options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, scheduled: { type: "boolean" } },
  allowPositionals: true,
  strict: false,
});

const [command] = positionals;
const home = arefineHome(process.env);

if (values.help || command === undefined) {
  process.stdout.write(USAGE);
} else if (command === "collect") {
  guard(() => exclusive(() => printCollected(collect(process.env))));
} else if ((command === "run" || command === "ack") && values.repo !== undefined && typeof values.repo !== "string") {
  process.stderr.write("--repo には owner/name の形でリポジトリを指定してください。\n");
  process.exitCode = 1;
} else if (command === "run") {
  const repo = typeof values.repo === "string" ? values.repo : undefined;
  guard(() =>
    exclusive(() =>
      printRun(
        run(process.env, {
          llm: claudeLlm,
          now: new Date(),
          onProgress: printProgress,
          ...(repo === undefined ? {} : { repo }),
        }),
        values.scheduled === true,
      ),
    ),
  );
} else if (command === "observe" && process.stdin.isTTY) {
  process.stderr.write("セルフレビューの結果の JSON を標準入力から渡してください（例: arefine observe < review.json）。\n");
  process.exitCode = 1;
} else if (command === "observe") {
  guard(() => {
    const { repo, added, duplicates } = observe(process.env, {
      input: readFileSync(0, "utf8"),
      cwd: process.cwd(),
      now: new Date(),
    });
    process.stdout.write(
      added + duplicates === 0
        ? `${repo}: セルフレビューの指摘がないので、何も追記していません。\n`
        : `${repo} に ${added} 件の修正指示を追記しました。${duplicates > 0 ? `${duplicates} 件はすでに追記済みだったので飛ばしました。` : ""}\n`,
    );
  });
} else if (command === "schedule") {
  guard(() => printSchedule());
} else if (command === "ack") {
  guard(() => printAck(typeof values.repo === "string" ? values.repo : resolveRepo(process.cwd())));
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

function exclusive(action: () => void): void {
  const locked: Locked<void> = withLock(home, action);
  if (!locked.ok) {
    process.stdout.write(
      `別の arefine${locked.holder === null ? "" : `（pid ${locked.holder}）`}が動いているため、何もせずに終わります。\n終わってからもう一度実行してください。動いていないのにこの表示が続くなら、${locked.file} を削除してください。\n`,
    );
  }
}

function printSchedule(): void {
  const { schedule, schedule_time: time } = loadConfig(home);
  const { plist, log } = writePlist(process.env, home, schedule, time);
  const clock = `${time.hour}:${String(time.minute).padStart(2, "0")}`;
  const when = `${schedule === "daily" ? "毎日" : "毎週月曜"} ${clock}`;
  process.stdout.write(`定期実行の設定を書き出しました: ${plist}
頻度: ${when}（config.yaml の schedule: ${schedule}, schedule_time: "${clock}"）。スリープ中だった分は、起きたときに1回だけ動きます。
ログ: ${log}

登録するには:
  launchctl bootstrap gui/$(id -u) "${plist}"
やめるには:
  launchctl bootout gui/$(id -u)/${LABEL}
  rm "${plist}"

頻度や時刻を変えたときや Node を入れ替えたときは、arefine schedule をもう一度実行し、bootout してから bootstrap し直してください。
`);
}

function printCollected({ logs, candidates, unreadable }: CollectSummary): void {
  process.stdout.write(`${logs} 件のセッションログから ${candidates} 件の発話を取り出しました。\n`);
  if (unreadable > 0) {
    process.stderr.write(
      `人間の発話のうち ${unreadable} 件は形式を読めず、取り出していません。\nClaude Code のログ形式が変わった可能性があります。sources/claude-code.ts のスキーマを確認してください。\n`,
    );
  }
}

function printProgress(progress: RunProgress): void {
  const message =
    progress.phase === "collect"
      ? "セッションログを読んでいます…"
      : progress.phase === "normalize"
        ? `${progress.repo}: 発話から修正指示を拾っています（${progress.done}/${progress.total} 件済み）`
        : `${progress.repo}: 観点 ${progress.refiner} に修正指示 ${progress.observations} 件を渡して、提案を待っています（数分かかることがあります）`;
  process.stderr.write(`${message}\n`);
}

function printAck(repo: string | null): void {
  if (repo === null) {
    process.stderr.write(
      "このフォルダのリポジトリが分かりません。git remote の origin があるフォルダで実行するか、--repo owner/name で指定してください。\n",
    );
    process.exitCode = 1;
    return;
  }
  const { proposals } = markRead(repoDir(home, repo));
  process.stdout.write(
    proposals === 0
      ? `${repo} にまだ読んでいない提案はありません。\n`
      : `${repo} の提案 ${proposals} 件を読んだことにしました。\n`,
  );
}

function printRun(summary: RunSummary, scheduled: boolean): void {
  printCollected(summary.collected);
  for (const name of summary.missing) {
    process.stderr.write(`config.yaml で有効にした観点 ${name} が見つかりません。名前と custom_refiners を確認してください。\n`);
  }
  if (summary.refiners.length === 0) {
    process.stdout.write(
      `有効な観点がないため、ここで止めました。\n${configFile(arefineHome(process.env))} で観点を有効にしてください（例: refiners: { lint: { enabled: true } }）。\n`,
    );
    if (scheduled) {
      process.stderr.write("定期実行で何もできなかったため、失敗として終わります。観点を有効にするか、定期実行をやめてください。\n");
      process.exitCode = 1;
    }
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
