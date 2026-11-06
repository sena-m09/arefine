import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config.ts";
import { UNKNOWN_REPO_DIR, arefineHome } from "../config/paths.ts";
import type { Llm } from "../llm/claude.ts";
import { Budget } from "./budget.ts";
import { collect } from "./collect.ts";
import type { CollectSummary } from "./collect.ts";
import { dispatchRepo, markDispatched } from "./dispatch.ts";
import type { DispatchResult } from "./dispatch.ts";
import { normalizeRepo } from "./normalize.ts";
import type { NormalizeResult } from "./normalize.ts";
import { BUILTIN_REFINERS_DIR, enabledRefiners } from "./refiners.ts";
import { writeReport } from "./report.ts";

export type RepoRun = {
  repo: string;
  normalize: NormalizeResult;
  dispatch: (DispatchResult & { refiner: string })[];
  report: string | null;
};

export type RunSummary = {
  collected: CollectSummary;
  refiners: string[];
  missing: string[];
  repos: RepoRun[];
  spentUsd: number;
  budgetUsd: number;
};

export type RunOptions = {
  llm: Llm;
  now: Date;
  builtinRefinersDir?: string;
};

export function run(env: NodeJS.ProcessEnv, options: RunOptions): RunSummary {
  const collected = collect(env);
  const home = arefineHome(env);
  const config = loadConfig(home);
  const { refiners, missing } = enabledRefiners(config, options.builtinRefinersDir ?? BUILTIN_REFINERS_DIR);
  const budget = new Budget(config.budget_usd);
  const summary = (repos: RepoRun[]): RunSummary => ({
    collected,
    refiners: refiners.map((refiner) => refiner.name),
    missing,
    repos,
    spentUsd: budget.spentUsd,
    budgetUsd: budget.limitUsd,
  });
  if (refiners.length === 0) {
    return summary([]);
  }

  const repos: RepoRun[] = [];
  for (const { dir, repo } of listRepoDirs(home)) {
    const normalized = normalizeRepo(dir, repo, options.llm, budget);
    const dispatched = refiners.map((refiner) => ({
      refiner: refiner.name,
      ...dispatchRepo(dir, repo, refiner, options.llm, budget),
    }));
    const report = writeReport(
      dir,
      repo,
      dispatched.map((result) => ({ refiner: result.refiner, proposals: result.proposals })),
      options.now,
    );
    for (const result of dispatched) {
      if (result.advanceTo !== null) {
        markDispatched(dir, result.refiner, result.advanceTo);
      }
    }
    repos.push({ repo, normalize: normalized, dispatch: dispatched, report });
  }
  return summary(repos);
}

function listRepoDirs(home: string): { dir: string; repo: string }[] {
  if (!existsSync(home)) {
    return [];
  }
  return readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== UNKNOWN_REPO_DIR)
    .map((entry) => ({ dir: join(home, entry.name), repo: entry.name.replace("__", "/") }))
    .filter(({ dir }) => existsSync(join(dir, "candidates.jsonl")))
    .toSorted((a, b) => modifiedAt(b.dir) - modifiedAt(a.dir));
}

function modifiedAt(dir: string): number {
  return statSync(join(dir, "candidates.jsonl")).mtimeMs;
}
