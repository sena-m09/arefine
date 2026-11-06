import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readYaml } from "./yaml.ts";

export const DEFAULT_BUDGET_USD = 1;

export const Schedule = z.enum(["daily", "weekly"]);
export type Schedule = z.infer<typeof Schedule>;

const Config = z.object({
  budget_usd: z.number().positive().default(DEFAULT_BUDGET_USD),
  refiners: z.record(z.string(), z.looseObject({ enabled: z.boolean().optional() })).default({}),
  custom_refiners: z.array(z.string()).default([]),
  schedule: Schedule.default("daily"),
});
export type Config = z.infer<typeof Config>;

export function configFile(home: string): string {
  return join(home, "config.yaml");
}

export function loadConfig(home: string): Config {
  const file = configFile(home);
  const config = existsSync(file) ? readYaml(file, Config) : Config.parse({});
  return {
    ...config,
    custom_refiners: config.custom_refiners.map((dir) => (dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir)),
  };
}
