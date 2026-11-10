import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readYaml } from "./yaml.ts";

export const DEFAULT_BUDGET_USD = 1;

export const Schedule = z.enum(["daily", "weekly"]);
export type Schedule = z.infer<typeof Schedule>;

export type ScheduleTime = { hour: number; minute: number };

const ScheduleTime = z.string().transform((text, ctx): ScheduleTime => {
  const [, hour, minute] = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text) ?? [];
  if (hour === undefined || minute === undefined) {
    ctx.addIssue({ code: "custom", message: `"08:30" のように 0:00〜23:59 の時刻で書いてください（いまの値: ${text}）` });
    return z.NEVER;
  }
  return { hour: Number(hour), minute: Number(minute) };
});

const Config = z.object({
  budget_usd: z.number().positive().default(DEFAULT_BUDGET_USD),
  refiners: z.record(z.string(), z.looseObject({ enabled: z.boolean().optional() })).default({}),
  custom_refiners: z.array(z.string()).default([]),
  schedule: Schedule.default("daily"),
  schedule_time: ScheduleTime.default({ hour: 3, minute: 0 }),
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
