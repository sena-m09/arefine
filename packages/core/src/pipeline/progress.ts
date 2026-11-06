import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseJson } from "./jsonl.ts";

const Progress = z.object({
  normalized: z.number().int().nonnegative().default(0),
  dispatched: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type Progress = z.infer<typeof Progress>;

export function progressFile(dir: string): string {
  return join(dir, "progress.json");
}

export function readProgress(dir: string): Progress {
  const file = progressFile(dir);
  if (!existsSync(file)) {
    return { normalized: 0, dispatched: {} };
  }
  const progress = Progress.safeParse(parseJson(readFileSync(file, "utf8")));
  if (!progress.success) {
    throw new Error(
      `${file} を読めません。\nこのファイルを削除すると、候補と observation を最初から処理し直します。そのときは LLM の費用がもう一度かかります。`,
    );
  }
  return progress.data;
}

export function writeProgress(dir: string, progress: Progress): void {
  writeJsonAtomic(progressFile(dir), progress);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
