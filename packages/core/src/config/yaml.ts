import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { z } from "zod";

export function readYaml<T extends z.ZodType>(file: string, schema: T): z.infer<T> {
  const parsed = schema.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(全体)"}: ${issue.message}`);
    throw new Error(`${file} の書き方が想定と違います。\n${issues.join("\n")}`);
  }
  return parsed.data;
}

function parseYaml(text: string): unknown {
  try {
    return parse(text) ?? {};
  } catch {
    return undefined;
  }
}
