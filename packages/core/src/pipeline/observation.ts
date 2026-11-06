import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "./jsonl.ts";

export const Source = z.enum(["claude-session", "codex-session", "self-review", "pr-review"]);

export const Observation = z.object({
  id: z.string(),
  at: z.string(),
  source: Source,
  repo: z.string(),
  cwd: z.string(),
  guidance_id: z.string().nullable(),
  summary: z.string(),
  ref: z.object({ candidate: z.string(), session: z.string(), log: z.string() }),
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
