import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import type { Llm, LlmRequest, LlmResult } from "../src/llm/claude.ts";
import { BUILTIN_REFINERS_DIR } from "../src/pipeline/refiners.ts";
import { run } from "../src/pipeline/run.ts";

const PromptCandidates = z.array(z.object({ id: z.string(), text: z.string() }));
const ObservationLine = z.object({ id: z.string(), summary: z.string(), source: z.string() });

type Outcome = "ok" | "fail";

function setup(options: { config?: string; costUsd?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "arefine-run-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const repoDir = join(home, "acme__widget");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(root, "claude", "projects"), { recursive: true });

  const refinersDir = join(root, "refiners");
  const sample = join(refinersDir, "sample");
  mkdirSync(sample, { recursive: true });
  writeFileSync(
    join(sample, "refiner.yaml"),
    "name: sample\ndescription: テスト用の観点\ninputs: [claude-session]\ndefault_enabled: false\n",
  );
  writeFileSync(join(sample, "SKILL.md"), "# テスト用の観点\n");
  writeFileSync(join(home, "config.yaml"), options.config ?? "refiners:\n  sample:\n    enabled: true\n");

  const calls: LlmRequest[] = [];
  const outcomes: Outcome[] = [];
  const costUsd = options.costUsd ?? 0.01;
  const llm: Llm = (request): LlmResult => {
    calls.push(request);
    if (outcomes.shift() === "fail") {
      return { ok: false, error: "API が落ちています", costUsd: 0 };
    }
    if (isNormalize(request)) {
      const candidates = PromptCandidates.parse(JSON.parse(request.prompt));
      return {
        ok: true,
        costUsd,
        output: {
          observations: candidates
            .filter((candidate) => candidate.text.endsWith("ないで"))
            .map((candidate) => ({ candidate_id: candidate.id, summary: candidate.text })),
        },
      };
    }
    const ids = [...request.prompt.matchAll(/"id":"(obs_[^"]+)"/g)].map((match) => match[1]);
    return {
      ok: true,
      costUsd,
      output: { proposals: [{ title: "fetch を lint で止める", observation_ids: ids, change: "no-restricted-globals で止める" }] },
    };
  };

  const runEnv = { AREFINE_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude") };
  const dirOf = (repo: string) => join(home, repo.replace("/", "__"));
  const addCandidatesTo = (repo: string, ...texts: string[]) => {
    mkdirSync(dirOf(repo), { recursive: true });
    writeFileSync(
      join(dirOf(repo), "candidates.jsonl"),
      texts
          .map((text) =>
            JSON.stringify({
              id: `c-${text}`,
              kind: "prompt",
              at: "2026-11-01T10:00:00.000Z",
              source: "claude-session",
              repo,
              cwd: "/home/user/example",
              text,
              ref: { session: "s-1", log: "/home/user/.claude/projects/example/s-1.jsonl" },
            }),
          )
          .map((line) => `${line}\n`)
          .join(""),
      { flag: "a" },
    );
  };

  return {
    home,
    calls,
    failNext: (...next: Outcome[]) => outcomes.push(...next),
    addCandidatesTo,
    addCandidates: (...texts: string[]) => addCandidatesTo("acme/widget", ...texts),
    observations: (repo = "acme/widget") =>
      existsSync(join(dirOf(repo), "observations.jsonl"))
        ? readFileSync(join(dirOf(repo), "observations.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => ObservationLine.parse(JSON.parse(line)))
        : [],
    reports: () => (existsSync(join(repoDir, "reports")) ? readdirSync(join(repoDir, "reports")) : []),
    readReport: (name: string) => readFileSync(join(repoDir, "reports", name), "utf8"),
    run: (options: { builtinRefinersDir?: string; repo?: string } = {}) =>
      run(runEnv, { llm, now: new Date(2026, 10, 6, 9, 30), builtinRefinersDir: refinersDir, ...options }),
  };
}

function isNormalize(request: LlmRequest): boolean {
  return JSON.stringify(request.schema).includes('"observations"');
}

describe("arefine run", () => {
  test("修正指示だけを observation にし、観点の提案を日付ごとのレポートに書く", () => {
    const { addCandidates, observations, reports, readReport, run } = setup();
    addCandidates("fetch を直接呼ばないで", "ありがとう");

    run();

    expect(observations().map((observation) => observation.summary)).toEqual(["fetch を直接呼ばないで"]);
    expect(reports()).toEqual(["2026-11-06.md"]);
    expect(readReport("2026-11-06.md")).toContain("### fetch を lint で止める");
    expect(readReport("2026-11-06.md")).toContain("`obs_c-fetch を直接呼ばないで_1`");
  });

  test("もう一度実行しても、処理済みの候補と observation を LLM に渡し直さず、observation も増えない", () => {
    const { addCandidates, observations, calls, run } = setup();
    addCandidates("fetch を直接呼ばないで");
    run();
    const callsAfterFirstRun = calls.length;

    run();

    expect(calls).toHaveLength(callsAfterFirstRun);
    expect(observations()).toHaveLength(1);
  });

  test("LLM の呼び出しに失敗したら、候補を処理済みにせず、次の実行でやり直す", () => {
    const { addCandidates, observations, failNext, run } = setup();
    addCandidates("fetch を直接呼ばないで");
    failNext("fail");

    const failed = run();
    expect(failed.repos[0]?.normalize.error).toContain("API が落ちています");
    expect(observations()).toEqual([]);

    run();
    expect(observations().map((observation) => observation.summary)).toEqual(["fetch を直接呼ばないで"]);
  });

  test("観点の実行に失敗したら、レポートを書かず、次の実行で同じ observation から提案を出す", () => {
    const { addCandidates, reports, failNext, run } = setup();
    addCandidates("fetch を直接呼ばないで");
    failNext("ok", "fail");

    run();
    expect(reports()).toEqual([]);

    run();
    expect(reports()).toEqual(["2026-11-06.md"]);
  });

  test("費用の上限に達したら、残りの候補を次の実行に回す", () => {
    const { addCandidates, observations, run } = setup({
      config: "budget_usd: 0.01\nrefiners:\n  sample:\n    enabled: true\n",
    });
    addCandidates(...Array.from({ length: 25 }, (_, i) => `${i} 番目を直接呼ばないで`));

    const first = run();
    expect(first.spentUsd).toBeGreaterThanOrEqual(0.01);
    expect(first.repos[0]?.normalize.pending).toBe(5);
    expect(observations()).toHaveLength(20);

    run();
    expect(observations()).toHaveLength(25);
  });

  test("リポジトリを指定すると、そのリポジトリの候補だけを処理する", () => {
    const { addCandidates, addCandidatesTo, observations, run } = setup();
    addCandidates("fetch を直接呼ばないで");
    addCandidatesTo("acme/gadget", "any を使わないで");

    run({ repo: "acme/gadget" });

    expect(observations("acme/gadget").map((observation) => observation.summary)).toEqual(["any を使わないで"]);
    expect(observations("acme/widget")).toEqual([]);
  });

  test("指定したリポジトリでの会話がなければ、LLM を呼ばずに会話のあるリポジトリを示して止める", () => {
    const { addCandidates, addCandidatesTo, calls, run } = setup();
    addCandidates("fetch を直接呼ばないで");
    addCandidatesTo("acme/gadget", "any を使わないで");

    const summary = run({ repo: "acme/widgte" });

    expect(summary.repoNotFound).toEqual({ requested: "acme/widgte", known: ["acme/gadget", "acme/widget"] });
    expect(calls).toEqual([]);
  });

  test("観点を有効にしていなければ、LLM を呼ばずに止める", () => {
    const { addCandidates, calls, run } = setup({ config: "refiners: {}\n" });
    addCandidates("fetch を直接呼ばないで");

    const summary = run();

    expect(summary.refiners).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("リポジトリが分からない会話の候補は LLM に渡さない", () => {
    const { home, calls, run } = setup();
    const unknownDir = join(home, "_unknown");
    mkdirSync(unknownDir);
    writeFileSync(join(unknownDir, "candidates.jsonl"), `${JSON.stringify({ id: "x", text: "直接呼ばないで" })}\n`);

    run();

    expect(calls).toEqual([]);
  });

  test("同梱の lint 観点は、config.yaml で有効にすると読み込める", () => {
    const { addCandidates, reports, run } = setup({ config: "refiners:\n  lint:\n    enabled: true\n" });
    addCandidates("fetch を直接呼ばないで");

    const summary = run({ builtinRefinersDir: BUILTIN_REFINERS_DIR });

    expect(summary.refiners).toEqual(["lint"]);
    expect(reports()).toEqual(["2026-11-06.md"]);
  });

  test("config.yaml の書き方が違えば、どの項目かを示して止める", () => {
    const { run } = setup({ config: "budget_usd: たくさん\n" });

    expect(() => run()).toThrow(/config\.yaml の書き方が想定と違います。\n {2}budget_usd:/);
  });
});
