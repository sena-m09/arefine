import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import type { Llm, LlmRequest, LlmResult } from "../src/llm/claude.ts";
import { BUILTIN_REFINERS_DIR } from "../src/pipeline/refiners.ts";
import { run } from "../src/pipeline/run.ts";
import type { RunOptions, RunProgress } from "../src/pipeline/run.ts";

const PromptCandidates = z.array(z.object({ id: z.string(), text: z.string() }));
const ObservationLine = z.object({ id: z.string(), summary: z.string(), source: z.string(), stated_as_rule: z.boolean() });

type Outcome = "ok" | "fail";

const NOW = new Date(2026, 10, 6, 9, 30);
const RUN_AT = NOW.toISOString();

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
  const groupings: Group[] = [];
  const refines: Refine[] = [];
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
            .map((candidate) => ({
              candidate_id: candidate.id,
              summary: candidate.text,
              stated_as_rule: candidate.text.startsWith("今後は"),
            })),
        },
      };
    }
    if (isGrouping(request)) {
      const group = groupings.shift() ?? groupBySummary;
      return { ok: true, costUsd, output: group(parseGroupingPrompt(request.prompt)) };
    }
    const refine = refines.shift() ?? proposeForAdded;
    return { ok: true, costUsd, output: refine(parseRefinerPrompt(request.prompt)) };
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

  const addObservations = (...observations: { id: string; summary: string }[]) => {
    writeFileSync(
      join(repoDir, "observations.jsonl"),
      observations
        .map((observation) =>
          JSON.stringify({
            ...observation,
            at: "2026-11-01T10:00:00.000Z",
            source: "claude-session",
            repo: "acme/widget",
            cwd: "/home/user/example",
            guidance_id: null,
            ref: { candidate: null, session: "s-1", log: null },
          }),
        )
        .map((line) => `${line}\n`)
        .join(""),
      { flag: "a" },
    );
  };

  return {
    home,
    repoDir,
    calls,
    failNext: (...next: Outcome[]) => outcomes.push(...next),
    groupNext: (...next: Group[]) => groupings.push(...next),
    refineNext: (...next: Refine[]) => refines.push(...next),
    addObservations,
    groupingInputs: () => calls.filter(isGrouping).map((call) => parseGroupingPrompt(call.prompt)),
    refinerInputs: () =>
      calls.filter((call) => !isNormalize(call) && !isGrouping(call)).map((call) => parseRefinerPrompt(call.prompt)),
    registry: () => RegistryFile.parse(JSON.parse(readFileSync(join(repoDir, "refiners", "sample", "registry.json"), "utf8"))),
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
    run: (options: Partial<RunOptions> = {}) =>
      run(runEnv, { llm, now: NOW, builtinRefinersDir: refinersDir, ...options }),
  };
}

function isNormalize(request: LlmRequest): boolean {
  return JSON.stringify(request.schema).includes('"observations"');
}

function isGrouping(request: LlmRequest): boolean {
  return JSON.stringify(request.schema).includes('"assignments"');
}

const GroupingGroup = z.object({ id: z.string(), summary: z.string(), count: z.number() });
const GroupingObservation = z.object({ key: z.string(), summary: z.string() });
type GroupingInput = { groups: z.infer<typeof GroupingGroup>[]; observations: z.infer<typeof GroupingObservation>[] };
type GroupingReply = {
  new_groups: { key: string; summary: string }[];
  assignments: { observation: string; group: string }[];
};
type Group = (input: GroupingInput) => GroupingReply;

const RefinerGroup = z.object({ id: z.string(), count: z.number(), added: z.number(), state: z.unknown().optional() });
const RefinerObservation = z.object({ group: z.string(), summary: z.string(), stated_as_rule: z.boolean() });
type RefinerInput = { groups: z.infer<typeof RefinerGroup>[]; observations: z.infer<typeof RefinerObservation>[] };
type RefinerReply = {
  judgments: { group: string; guidance_id: string | null; trackable: boolean; state: Record<string, unknown> }[];
  resolved: string[];
  proposals: { title: string; groups: string[]; change: string }[];
};
type Refine = (input: RefinerInput) => RefinerReply;

const RegistryFile = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      observation_ids: z.array(z.string()),
      judged_at: z.string().nullable(),
      count_at_judgment: z.number().nullable(),
      resolved_at: z.string().nullable(),
      state: z.unknown(),
    }),
  ),
  unassigned: z.array(z.string()),
});

function jsonLines(prompt: string, prefix: string): unknown[] {
  return prompt
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line): unknown => JSON.parse(line));
}

function parseGroupingPrompt(prompt: string): GroupingInput {
  return {
    groups: jsonLines(prompt, '{"id":').map((line) => GroupingGroup.parse(line)),
    observations: jsonLines(prompt, '{"key":').map((line) => GroupingObservation.parse(line)),
  };
}

function parseRefinerPrompt(prompt: string): RefinerInput {
  return {
    groups: jsonLines(prompt, '{"id":').map((line) => RefinerGroup.parse(line)),
    observations: jsonLines(prompt, '{"group":').map((line) => RefinerObservation.parse(line)),
  };
}

function groupBySummary({ groups, observations }: GroupingInput): GroupingReply {
  const newGroups = [...new Set(observations.map((observation) => observation.summary))]
    .filter((summary) => !groups.some((group) => group.summary === summary))
    .map((summary, i) => ({ key: `n${i + 1}`, summary }));
  const groupOf = (summary: string) =>
    groups.find((group) => group.summary === summary)?.id ?? newGroups.find((group) => group.summary === summary)?.key ?? "";
  return {
    new_groups: newGroups,
    assignments: observations.map((observation) => ({ observation: observation.key, group: groupOf(observation.summary) })),
  };
}

function proposeForAdded({ groups }: RefinerInput): RefinerReply {
  return {
    judgments: [],
    resolved: [],
    proposals: [
      {
        title: "fetch を lint で止める",
        groups: groups.filter((group) => group.added > 0).map((group) => group.id),
        change: "no-restricted-globals で止める",
      },
    ],
  };
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

  test("今後のルールとして言い切った指示には、observation に印を付ける", () => {
    const { addCandidates, observations, run } = setup();
    addCandidates("今後は fetch を直接呼ばないで", "any を使わないで");

    run();

    expect(observations().map(({ summary, stated_as_rule }) => ({ summary, stated_as_rule }))).toEqual([
      { summary: "今後は fetch を直接呼ばないで", stated_as_rule: true },
      { summary: "any を使わないで", stated_as_rule: false },
    ]);
  });

  test("印を持たない以前の observation も、言い切っていない指示として観点に渡す", () => {
    const { repoDir, addCandidates, refinerInputs, readReport, run } = setup();
    addCandidates("ありがとう");
    const observation = {
      at: "2026-11-01T10:00:00.000Z",
      source: "claude-session",
      repo: "acme/widget",
      cwd: "/home/user/example",
      guidance_id: null,
      summary: "fetch を直接呼ばない",
      ref: { candidate: "c-1", session: "s-1", log: "/home/user/.claude/projects/example/s-1.jsonl" },
    };
    writeFileSync(
      join(repoDir, "observations.jsonl"),
      [{ ...observation, id: "obs_old_1" }, { ...observation, id: "obs_new_1", stated_as_rule: true }]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(""),
    );

    run();

    expect(refinerInputs().at(-1)?.observations.map(({ stated_as_rule }) => stated_as_rule)).toEqual([false, true]);
    expect(readReport("2026-11-06.md")).toContain("`obs_old_1`");
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

  test("処理の進み具合を、ログの読み込み・修正指示の拾い出し・観点の実行の順に知らせる", () => {
    const { addCandidates, run } = setup();
    addCandidates(...Array.from({ length: 25 }, (_, i) => `${i} 番目を直接呼ばないで`));
    const progress: RunProgress[] = [];

    run({ onProgress: (event) => progress.push(event) });

    expect(progress).toEqual([
      { phase: "collect" },
      { phase: "normalize", repo: "acme/widget", done: 0, total: 25 },
      { phase: "normalize", repo: "acme/widget", done: 20, total: 25 },
      { phase: "dispatch", repo: "acme/widget", refiner: "sample", observations: 25 },
    ]);
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

describe("実行をまたいだ指示のまとまり", () => {
  test("前の実行と同じ指示は同じまとまりに足し、件数を実行をまたいで数える", () => {
    const { addObservations, groupingInputs, refinerInputs, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    run();
    addObservations({ id: "obs_b", summary: "fetch を直接呼ばない" });

    run();

    expect(groupingInputs().at(-1)?.groups.map(({ id, count }) => ({ id, count }))).toEqual([{ id: "I-001", count: 1 }]);
    expect(refinerInputs().at(-1)?.groups.map(({ id, count, added }) => ({ id, count, added }))).toEqual([
      { id: "I-001", count: 2, added: 1 },
    ]);
    expect(registry().groups.map(({ id, observation_ids }) => ({ id, observation_ids }))).toEqual([
      { id: "I-001", observation_ids: ["obs_a", "obs_b"] },
    ]);
  });

  test("提案の根拠には、前の実行で同じまとまりに入れた observation も載せる", () => {
    const { addObservations, readReport, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    run();
    addObservations({ id: "obs_b", summary: "fetch を直接呼ばない" });

    run();

    expect(readReport("2026-11-06.md")).toContain("根拠: I-001（`obs_a`, `obs_b`）");
  });

  test("振り分けには observation の id でなく短い key を渡し、まとまりには元の id で残す", () => {
    const { addObservations, groupingInputs, registry, run } = setup();
    addObservations({ id: "obs_長い_id_1", summary: "fetch を直接呼ばない" });

    run();

    expect(groupingInputs()[0]?.observations).toEqual([{ key: "o1", summary: "fetch を直接呼ばない" }]);
    expect(registry().groups[0]?.observation_ids).toEqual(["obs_長い_id_1"]);
  });

  test("振り分けられなかった observation は観点に渡さず、次の実行でもう一度振り分ける", () => {
    const { addObservations, groupNext, groupingInputs, refinerInputs, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" }, { id: "obs_b", summary: "any を使わない" });
    groupNext((input) => {
      const reply = groupBySummary(input);
      return { ...reply, assignments: [...reply.assignments.slice(0, 1), { observation: "o9", group: "n2" }] };
    });
    run();
    expect(refinerInputs()[0]?.observations.map(({ summary }) => summary)).toEqual(["fetch を直接呼ばない"]);
    expect(registry().unassigned).toEqual(["obs_b"]);

    run();

    expect(groupingInputs().at(-1)?.observations.map(({ summary }) => summary)).toEqual(["any を使わない"]);
    expect(registry().groups.flatMap(({ observation_ids }) => observation_ids)).toEqual(["obs_a", "obs_b"]);
    expect(registry().unassigned).toEqual([]);
  });

  test("どの observation も振り分けられなければ、観点を呼ばずに次の実行へ回す", () => {
    const { addObservations, groupNext, refinerInputs, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    groupNext(() => ({ new_groups: [], assignments: [] }));

    run();

    expect(refinerInputs()).toEqual([]);
    expect(registry().unassigned).toEqual(["obs_a"]);
  });

  test("観点には、今回 observation が入ったまとまりと、判定済みのまとまりだけを渡す", () => {
    const { addObservations, refineNext, refinerInputs, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" }, { id: "obs_b", summary: "any を使わない" });
    refineNext((input) => ({
      ...proposeForAdded(input),
      judgments: [{ group: "I-001", guidance_id: null, trackable: false, state: {} }],
    }));
    run();
    addObservations({ id: "obs_c", summary: "enum を使わない" });

    run();

    expect(refinerInputs().at(-1)?.groups.map(({ id }) => id)).toEqual(["I-001", "I-003"]);
  });

  test("観点の判定は中身を読まずに残し、判定の日時と件数を添えて次の実行で観点に渡す", () => {
    const { addObservations, refineNext, refinerInputs, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" }, { id: "obs_b", summary: "fetch を直接呼ばない" });
    const state = { result: "existing-rule", linters: { oxlint: "1.0.0" } };
    refineNext((input) => ({
      ...proposeForAdded(input),
      judgments: [{ group: "I-001", guidance_id: null, trackable: true, state }],
    }));
    run();
    addObservations({ id: "obs_c", summary: "fetch を直接呼ばない" });

    run();

    expect(registry().groups[0]).toMatchObject({ judged_at: RUN_AT, count_at_judgment: 2, state });
    expect(refinerInputs().at(-1)?.groups[0]).toMatchObject({ id: "I-001", count: 3, state });
  });

  test("提案が取り入れられたまとまりを記録し、取り入れた割合をレポートに出す", () => {
    const { addObservations, refineNext, registry, readReport, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    refineNext((input) => ({
      ...proposeForAdded(input),
      judgments: [{ group: "I-001", guidance_id: null, trackable: true, state: { rule: "no-restricted-globals" } }],
    }));
    run();
    addObservations({ id: "obs_b", summary: "any を使わない" });
    refineNext((input) => ({ ...proposeForAdded(input), resolved: ["I-001"] }));

    run();

    expect(registry().groups[0]?.resolved_at).toBe(RUN_AT);
    expect(readReport("2026-11-06.md")).toContain("取り入れたかを確かめる提案 1 件のうち、取り入れ済みは 1 件（100%）です。");
  });

  test("振り分けのあとで観点の実行に失敗したら、振り分けも残さず、次の実行でやり直す", () => {
    const { repoDir, addObservations, failNext, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    failNext("ok", "fail");

    run();
    expect(existsSync(join(repoDir, "refiners", "sample", "registry.json"))).toBe(false);

    run();
    expect(registry().groups[0]?.observation_ids).toEqual(["obs_a"]);
  });

  test("まとまりの記録がなければ、観点に渡し終えた observation も最初から振り分け直す", () => {
    const { repoDir, addObservations, groupingInputs, registry, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    const size = readFileSync(join(repoDir, "observations.jsonl")).length;
    writeFileSync(join(repoDir, "progress.json"), JSON.stringify({ normalized: 0, dispatched: { sample: size } }));

    run();

    expect(groupingInputs().at(-1)?.observations.map(({ summary }) => summary)).toEqual(["fetch を直接呼ばない"]);
    expect(registry().groups[0]?.observation_ids).toEqual(["obs_a"]);
  });

  test("すでにまとまりに入っている observation は、読み直しても振り分け直さない", () => {
    const { repoDir, addObservations, groupingInputs, run } = setup();
    addObservations({ id: "obs_a", summary: "fetch を直接呼ばない" });
    run();
    writeFileSync(join(repoDir, "progress.json"), JSON.stringify({ normalized: 0, dispatched: { sample: 0 } }));

    run();

    expect(groupingInputs()).toHaveLength(1);
  });
});
