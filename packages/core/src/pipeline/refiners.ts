import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Config } from "../config/config.ts";
import { readYaml } from "../config/yaml.ts";
import { Source } from "./observation.ts";

export const BUILTIN_REFINERS_DIR = fileURLToPath(new URL("../../../../refiners/", import.meta.url));

const RefinerManifest = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  inputs: z.array(Source).min(1),
  default_enabled: z.boolean(),
});

export type Refiner = z.infer<typeof RefinerManifest> & {
  dir: string;
  skill: string;
  settings: Record<string, unknown>;
};

export type EnabledRefiners = {
  refiners: Refiner[];
  missing: string[];
};

export function enabledRefiners(config: Config, builtinDir: string = BUILTIN_REFINERS_DIR): EnabledRefiners {
  const all = [...listRefinerDirs(builtinDir), ...config.custom_refiners].map(readRefiner);
  const names = new Set(all.map((refiner) => refiner.name));
  const refiners = all
    .filter((refiner) => config.refiners[refiner.name]?.enabled ?? refiner.default_enabled)
    .map((refiner) => {
      const { enabled: _enabled, ...settings } = config.refiners[refiner.name] ?? {};
      return { ...refiner, settings };
    });
  const missing = Object.entries(config.refiners)
    .filter(([name, settings]) => settings.enabled === true && !names.has(name))
    .map(([name]) => name);
  return { refiners, missing };
}

function listRefinerDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "refiner.yaml")))
    .map((entry) => join(root, entry.name));
}

function readRefiner(dir: string): Omit<Refiner, "settings"> {
  const manifestFile = join(dir, "refiner.yaml");
  const skillFile = join(dir, "SKILL.md");
  if (!existsSync(manifestFile) || !existsSync(skillFile)) {
    throw new Error(`${dir} に refiner.yaml と SKILL.md が見つかりません。観点のディレクトリには両方を置いてください。`);
  }
  return { ...readYaml(manifestFile, RefinerManifest), dir, skill: readFileSync(skillFile, "utf8") };
}
