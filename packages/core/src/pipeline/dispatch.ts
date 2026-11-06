import { existsSync } from "node:fs";
import { z } from "zod";
import type { Llm } from "../llm/claude.ts";
import type { Budget } from "./budget.ts";
import { parseJson, readNewLineEntries } from "./jsonl.ts";
import { Observation, observationsFile } from "./observation.ts";
import { readProgress, writeProgress } from "./progress.ts";
import type { Refiner } from "./refiners.ts";

const MAX_OBSERVATIONS = 100;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

const CONTRACT = `## aRefine から渡すものと返してほしいもの

入力には、対象のリポジトリ名、作業フォルダ、この観点の設定、observation の一覧が入っています。
observation は、人間が AI に出した修正指示を 1 件ずつまとめたものです。
作業フォルダがあるときは、Read・Grep・Glob でそのリポジトリのファイルを読めます。ファイルは書き換えません。

提案は proposals に入れます。
- title：提案を一言で表す見出し
- observation_ids：根拠にした observation の id（入力にある id だけ）
- change：変更案。Markdown で書き、そのまま人が読むレポートに載ります
提案することがなければ proposals は空にします。`;

const RefinerOutput = z.object({
  proposals: z.array(
    z.object({
      title: z.string().min(1),
      observation_ids: z.array(z.string()),
      change: z.string().min(1),
    }),
  ),
});
export type Proposal = z.infer<typeof RefinerOutput>["proposals"][number];

export type DispatchResult = {
  observations: number;
  proposals: Proposal[];
  pending: number;
  costUsd: number;
  error: string | null;
  advanceTo: number | null;
};

export function dispatchRepo(dir: string, repo: string, refiner: Refiner, llm: Llm, budget: Budget): DispatchResult {
  const file = observationsFile(dir);
  const empty = { observations: 0, proposals: [], pending: 0, costUsd: 0, error: null, advanceTo: null };
  if (!existsSync(file)) {
    return empty;
  }
  const progress = readProgress(dir);
  const entries = readNewLineEntries(file, progress.dispatched[refiner.name] ?? 0).entries;
  const batch = entries.slice(0, MAX_OBSERVATIONS);
  const end = batch.at(-1)?.end;
  if (end === undefined) {
    return empty;
  }
  const observations = batch
    .flatMap((entry) => {
      const observation = Observation.safeParse(parseJson(entry.text));
      return observation.success ? [observation.data] : [];
    })
    .filter((observation) => refiner.inputs.includes(observation.source));
  if (observations.length === 0) {
    return { ...empty, pending: entries.length - batch.length, advanceTo: end };
  }
  if (budget.exhausted) {
    return { ...empty, pending: entries.length };
  }

  const cwd = observations.toReversed().find((observation) => existsSync(observation.cwd))?.cwd;
  const result = llm({
    system: `${refiner.skill}\n\n${CONTRACT}`,
    prompt: [
      `リポジトリ: ${repo}`,
      `作業フォルダ: ${cwd ?? "なし（ファイルは読めません）"}`,
      `観点の設定: ${JSON.stringify(refiner.settings)}`,
      "observation:",
      ...observations.map((observation) => JSON.stringify(observation)),
    ].join("\n"),
    schema: z.toJSONSchema(RefinerOutput),
    maxBudgetUsd: budget.remainingUsd,
    ...(cwd === undefined ? {} : { cwd, tools: READ_ONLY_TOOLS }),
  });
  budget.charge(result.costUsd);
  if (!result.ok) {
    return { ...empty, pending: entries.length, costUsd: result.costUsd, error: result.error };
  }
  const output = RefinerOutput.safeParse(result.output);
  if (!output.success) {
    return {
      ...empty,
      pending: entries.length,
      costUsd: result.costUsd,
      error: `観点 ${refiner.name} の出力が想定した形式ではありません`,
    };
  }
  const ids = new Set(observations.map((observation) => observation.id));
  return {
    observations: observations.length,
    proposals: output.data.proposals.map((proposal) => ({
      ...proposal,
      observation_ids: proposal.observation_ids.filter((id) => ids.has(id)),
    })),
    pending: entries.length - batch.length,
    costUsd: result.costUsd,
    error: null,
    advanceTo: end,
  };
}

export function markDispatched(dir: string, refinerName: string, offset: number): void {
  const progress = readProgress(dir);
  writeProgress(dir, { ...progress, dispatched: { ...progress.dispatched, [refinerName]: offset } });
}
