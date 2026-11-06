import { existsSync } from "node:fs";
import { z } from "zod";
import type { Llm } from "../llm/claude.ts";
import type { Budget } from "./budget.ts";
import { parseJson, readNewLineEntries } from "./jsonl.ts";
import { Observation, observationsFile, readObservations } from "./observation.ts";
import { readProgress, writeProgress } from "./progress.ts";
import type { Refiner } from "./refiners.ts";
import { requestGrouping } from "./group.ts";
import { EMPTY_REGISTRY, applyGrouping, applyJudgments, readRegistry, registryStats } from "./registry.ts";
import type { Group, GroupedProposal, Registry, RegistryStats } from "./registry.ts";

const MAX_OBSERVATIONS = 100;
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

const CONTRACT = `## aRefine から渡すものと返してほしいもの

入力には、対象のリポジトリ名、作業フォルダ、この観点の設定、指示のまとまり、今回まとまりに入った observation の一覧が入っています。
observation は、人間が AI に出した修正指示を 1 件ずつまとめたもので、group は入ったまとまりの id です。
stated_as_rule が true の observation は、人間が「今後は」「必ず」のように、これから先も守るルールとして言い切った指示です。
指示のまとまりは、中身が同じ指示の observation を、実行をまたいで集めたものです。
今回 observation が入ったまとまりと、前に判定したまとまりだけを渡します。
id（I-001 など）、指示の中身の 1 文（summary）、対応する guidance ID（guidance_id）、これまでの件数（count）、今回入った件数（added）を持ちます。
前に判定したまとまりには、判定した日時（judged_at）、そのときの件数（count_at_judgment）、取り入れられたかを確かめる対象か（trackable）、取り入れを確かめた日時（resolved_at）、この観点が残した記録（state）も付きます。
作業フォルダがあるときは、Read・Grep・Glob でそのリポジトリのファイルを読めます。ファイルは書き換えません。

返すもの：
- judgments：今回判定したまとまり。group はまとまりの id、guidance_id は対応する guidance ID（G-012 の形。なければ null）。state には、この観点が次の判定で使う記録を入れます。aRefine は state の中身を読まずに保存し、次の実行でそのまま渡します。trackable は、提案が取り入れられたかを次の判定で確かめられるなら true にします
- resolved：前に判定したまとまりのうち、提案が取り入れられたと確かめられたものの id
- proposals：提案。title は提案を一言で表す見出し、groups は根拠にしたまとまりの id、change は Markdown で書いた変更案で、そのまま人が読むレポートに載ります
提案することがなければ proposals は空にします。`;

const RefinerOutput = z.object({
  judgments: z.array(
    z.object({
      group: z.string(),
      guidance_id: z.string().nullable(),
      trackable: z.boolean(),
      state: z.record(z.string(), z.unknown()),
    }),
  ),
  resolved: z.array(z.string()),
  proposals: z.array(z.object({ title: z.string().min(1), groups: z.array(z.string()), change: z.string().min(1) })),
});
export type RefinerOutput = z.infer<typeof RefinerOutput>;

export type DispatchResult = {
  observations: number;
  proposals: GroupedProposal[];
  pending: number;
  costUsd: number;
  error: string | null;
  advanceTo: number | null;
  registry: Registry | null;
  stats: RegistryStats | null;
};

export function dispatchRepo(
  dir: string,
  repo: string,
  refiner: Refiner,
  llm: Llm,
  budget: Budget,
  now: Date,
  onStart: (observations: number) => void = () => {},
): DispatchResult {
  const file = observationsFile(dir);
  const empty = {
    observations: 0,
    proposals: [],
    pending: 0,
    costUsd: 0,
    error: null,
    advanceTo: null,
    registry: null,
    stats: null,
  };
  if (!existsSync(file)) {
    return empty;
  }
  const saved = readRegistry(dir, refiner.name);
  const registry = saved ?? EMPTY_REGISTRY;
  const offset = saved === null ? 0 : (readProgress(dir).dispatched[refiner.name] ?? 0);
  const alreadyGrouped = new Set(registry.groups.flatMap((group) => group.observation_ids));
  const leftover = new Set(registry.unassigned.filter((id) => !alreadyGrouped.has(id)));
  const carried = leftover.size === 0 ? [] : readObservations(dir).filter((observation) => leftover.has(observation.id));

  const entries = readNewLineEntries(file, offset).entries;
  const batch = entries.slice(0, Math.max(0, MAX_OBSERVATIONS - carried.length));
  const advanceTo = batch.at(-1)?.end ?? null;
  const pending = entries.length - batch.length;
  const fresh = batch
    .flatMap((entry) => {
      const observation = Observation.safeParse(parseJson(entry.text));
      return observation.success ? [observation.data] : [];
    })
    .filter((observation) => !alreadyGrouped.has(observation.id) && !leftover.has(observation.id));
  const observations = [...carried, ...fresh]
    .filter((observation) => refiner.inputs.includes(observation.source))
    .map((observation, i) => ({ key: `o${i + 1}`, observation }));

  if (observations.length === 0) {
    return { ...empty, pending, advanceTo, registry: advanceTo === null ? null : { ...registry, unassigned: [] } };
  }
  if (budget.exhausted) {
    return { ...empty, pending: entries.length + carried.length };
  }

  onStart(observations.length);
  const grouping = requestGrouping(
    llm,
    budget,
    registry,
    observations.map(({ key, observation }) => ({ key, summary: observation.summary })),
  );
  const failed = { ...empty, pending: entries.length + carried.length, costUsd: grouping.costUsd };
  if (!grouping.ok) {
    return { ...failed, error: grouping.error };
  }
  const grouped = applyGrouping(
    registry,
    observations.map(({ key, observation }) => ({ key, id: observation.id })),
    grouping.output,
  );
  const added = observations.flatMap(({ observation }) => {
    const group = grouped.groupOf.get(observation.id);
    return group === undefined ? [] : [{ group, observation }];
  });
  if (added.length === 0) {
    return {
      ...empty,
      pending: pending + grouped.registry.unassigned.length,
      costUsd: grouping.costUsd,
      advanceTo,
      registry: grouped.registry,
    };
  }
  if (budget.exhausted) {
    return { ...failed, error: null };
  }

  const cwd = added.toReversed().find(({ observation }) => existsSync(observation.cwd))?.observation.cwd;
  const addedTo = Map.groupBy(added, ({ group }) => group);
  const result = llm({
    system: `${refiner.skill}\n\n${CONTRACT}`,
    prompt: [
      `リポジトリ: ${repo}`,
      `作業フォルダ: ${cwd ?? "なし（ファイルは読めません）"}`,
      `観点の設定: ${JSON.stringify(refiner.settings)}`,
      "指示のまとまり:",
      ...grouped.registry.groups
        .filter((group) => addedTo.has(group.id) || group.judged_at !== null)
        .map((group) => JSON.stringify(groupForPrompt(group, addedTo.get(group.id)?.length ?? 0))),
      "今回まとまりに入った observation:",
      ...added.map(({ group, observation }) => JSON.stringify(observationForPrompt(group, observation))),
    ].join("\n"),
    schema: z.toJSONSchema(RefinerOutput),
    maxBudgetUsd: budget.limitUsd,
    ...(cwd === undefined ? {} : { cwd, tools: READ_ONLY_TOOLS }),
  });
  budget.charge(result.costUsd);
  const costUsd = grouping.costUsd + result.costUsd;
  if (!result.ok) {
    return { ...failed, costUsd, error: result.error };
  }
  const output = RefinerOutput.safeParse(result.output);
  if (!output.success) {
    return { ...failed, costUsd, error: `観点 ${refiner.name} の出力が想定した形式ではありません` };
  }
  const judged = applyJudgments(grouped.registry, output.data, now);
  return {
    observations: observations.length,
    proposals: judged.proposals,
    pending: pending + judged.registry.unassigned.length,
    costUsd,
    error: null,
    advanceTo,
    registry: judged.registry,
    stats: registryStats(judged.registry),
  };
}

function groupForPrompt(group: Group, added: number) {
  const base = {
    id: group.id,
    summary: group.summary,
    guidance_id: group.guidance_id,
    count: group.observation_ids.length,
    added,
  };
  return group.judged_at === null
    ? base
    : {
        ...base,
        judged_at: group.judged_at,
        count_at_judgment: group.count_at_judgment,
        trackable: group.trackable,
        resolved_at: group.resolved_at,
        state: group.state,
      };
}

function observationForPrompt(group: string, observation: Observation) {
  const { id: _id, repo: _repo, cwd: _cwd, ref: _ref, ...rest } = observation;
  return { group, ...rest };
}

export function markDispatched(dir: string, refinerName: string, offset: number): void {
  const progress = readProgress(dir);
  writeProgress(dir, { ...progress, dispatched: { ...progress.dispatched, [refinerName]: offset } });
}
