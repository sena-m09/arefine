import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RefinerOutput } from "./dispatch.ts";
import type { GroupingOutput } from "./group.ts";
import { parseJson } from "./jsonl.ts";
import { GuidanceId } from "./observation.ts";
import { writeJsonAtomic } from "./progress.ts";

const Group = z.object({
  id: z.string(),
  summary: z.string(),
  guidance_id: z.string().nullable(),
  observation_ids: z.array(z.string()),
  judged_at: z.string().nullable(),
  count_at_judgment: z.number().int().nonnegative().nullable(),
  trackable: z.boolean().nullable(),
  resolved_at: z.string().nullable(),
  state: z.record(z.string(), z.unknown()).nullable(),
});
export type Group = z.infer<typeof Group>;

const Registry = z.object({
  groups: z.array(Group),
  unassigned: z.array(z.string()),
});
export type Registry = z.infer<typeof Registry>;

export const EMPTY_REGISTRY: Registry = { groups: [], unassigned: [] };

export type GroupedProposal = {
  title: string;
  change: string;
  groups: { id: string; observation_ids: string[] }[];
};

export type RegistryStats = {
  judged: number;
  trackable: number;
  resolved: number;
};

export function registryFile(dir: string, refinerName: string): string {
  return join(dir, "refiners", refinerName, "registry.json");
}

export function readRegistry(dir: string, refinerName: string): Registry | null {
  const file = registryFile(dir, refinerName);
  if (!existsSync(file)) {
    return null;
  }
  const registry = Registry.safeParse(parseJson(readFileSync(file, "utf8")));
  if (!registry.success) {
    throw new Error(
      `${file} を読めません。\nこのファイルを削除すると、観点 ${refinerName} はこれまでの observation を最初から振り分け直します。そのときは LLM の費用がもう一度かかります。`,
    );
  }
  return registry.data;
}

export function writeRegistry(dir: string, refinerName: string, registry: Registry): void {
  writeJsonAtomic(registryFile(dir, refinerName), registry);
}

export function applyGrouping(
  registry: Registry,
  batch: { key: string; id: string }[],
  output: GroupingOutput,
): { registry: Registry; groupOf: Map<string, string> } {
  const idOfKey = new Map(batch.map(({ key, id }) => [key, id]));
  const firstNumber = Math.max(0, ...registry.groups.map((group) => Number(group.id.replace(/^I-/, "")) || 0)) + 1;
  const created = output.new_groups
    .filter((group, i, all) => all.findIndex((other) => other.key === group.key) === i)
    .map((group, i) => ({
      key: group.key,
      group: {
        id: `I-${String(firstNumber + i).padStart(3, "0")}`,
        summary: group.summary,
        guidance_id: null,
        observation_ids: [],
        judged_at: null,
        count_at_judgment: null,
        trackable: null,
        resolved_at: null,
        state: null,
      } satisfies Group,
    }));
  const groupIdOf = new Map([
    ...registry.groups.map((group): [string, string] => [group.id, group.id]),
    ...created.map(({ key, group }): [string, string] => [key, group.id]),
  ]);
  const accepted = output.assignments
    .filter((assignment, i, all) => all.findIndex((other) => other.observation === assignment.observation) === i)
    .flatMap((assignment) => {
      const observationId = idOfKey.get(assignment.observation);
      const groupId = groupIdOf.get(assignment.group);
      return observationId === undefined || groupId === undefined ? [] : [{ observationId, groupId }];
    });
  const groupOf = new Map(accepted.map(({ observationId, groupId }) => [observationId, groupId]));
  const groups = [...registry.groups, ...created.map(({ group }) => group)]
    .map((group) => ({
      ...group,
      observation_ids: [
        ...group.observation_ids,
        ...accepted.filter(({ groupId }) => groupId === group.id).map(({ observationId }) => observationId),
      ],
    }))
    .filter((group) => group.observation_ids.length > 0);
  return {
    registry: { groups, unassigned: batch.map(({ id }) => id).filter((id) => !groupOf.has(id)) },
    groupOf,
  };
}

export function applyJudgments(
  registry: Registry,
  output: RefinerOutput,
  now: Date,
): { registry: Registry; proposals: GroupedProposal[] } {
  const judgedAt = now.toISOString();
  const judgments = new Map(output.judgments.map((judgment) => [judgment.group, judgment]));
  const resolved = new Set(output.resolved);
  const groups = registry.groups
    .map((group) => {
      const judgment = judgments.get(group.id);
      return judgment === undefined
        ? group
        : {
            ...group,
            guidance_id: validGuidanceId(judgment.guidance_id) ?? group.guidance_id,
            judged_at: judgedAt,
            count_at_judgment: group.observation_ids.length,
            trackable: judgment.trackable,
            state: judgment.state,
          };
    })
    .map((group) =>
      resolved.has(group.id) && group.judged_at !== null && group.resolved_at === null
        ? { ...group, resolved_at: judgedAt }
        : group,
    );
  const byId = new Map(groups.map((group) => [group.id, group]));
  const proposals = output.proposals.map((proposal) => ({
    title: proposal.title,
    change: proposal.change,
    groups: [...new Set(proposal.groups)].flatMap((id) => {
      const group = byId.get(id);
      return group === undefined ? [] : [{ id, observation_ids: group.observation_ids }];
    }),
  }));
  return { registry: { ...registry, groups }, proposals };
}

export function registryStats(registry: Registry): RegistryStats {
  const judged = registry.groups.filter((group) => group.judged_at !== null);
  const trackable = judged.filter((group) => group.trackable === true);
  return {
    judged: judged.length,
    trackable: trackable.length,
    resolved: trackable.filter((group) => group.resolved_at !== null).length,
  };
}

function validGuidanceId(value: string | null): string | null {
  return value !== null && GuidanceId.safeParse(value).success ? value : null;
}
