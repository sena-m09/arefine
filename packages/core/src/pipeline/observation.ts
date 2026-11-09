import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "./jsonl.ts";

export const Source = z.enum(["claude-session", "codex-session", "self-review", "pr-review"]);

export const GuidanceId = z.string().regex(/^G-\d{3}$/, "guidance ID は G-012 のように、G- と3桁の数字で書いてください");

export const RiskKind = z.enum(["data-loss", "outbound", "leak"]);

export const Evidence = z.object({ violation: z.string().min(1), fix: z.string().min(1).nullable() });

export const Observation = z.object({
  id: z.string(),
  at: z.string(),
  source: Source,
  repo: z.string(),
  cwd: z.string(),
  guidance_id: z.string().nullable(),
  summary: z.string(),
  stated_as_rule: z.boolean().default(false),
  risk_kind: RiskKind.nullable().default(null),
  evidence: Evidence.optional(),
  ref: z.object({ candidate: z.string().nullable(), session: z.string(), log: z.string().nullable() }),
});

export type Observation = z.infer<typeof Observation>;

export function observationsFile(dir: string): string {
  return join(dir, "observations.jsonl");
}

export function readObservations(dir: string): Observation[] {
  const file = observationsFile(dir);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const observation = Observation.safeParse(parseJson(line));
      return observation.success ? [observation.data] : [];
    });
}

export function appendObservations(dir: string, observations: Observation[]): Observation[] {
  const known = new Set(readObservations(dir).map((observation) => observation.id));
  const fresh = observations.filter((observation) => !known.has(observation.id));
  mkdirSync(dir, { recursive: true });
  appendFileSync(observationsFile(dir), fresh.map((observation) => `${JSON.stringify(observation)}\n`).join(""));
  return fresh;
}
