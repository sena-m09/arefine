import { arefineHome, repoDir } from "../config/paths.ts";
import { SelfReview, selfReviewObservations } from "../sources/self-review.ts";
import { parseJson } from "./jsonl.ts";
import { appendObservations } from "./observation.ts";
import { resolveRepo } from "./repo.ts";

export type ObserveSummary = {
  repo: string;
  added: number;
  duplicates: number;
};

export type ObserveOptions = {
  input: string;
  cwd: string;
  now: Date;
};

export function observe(env: NodeJS.ProcessEnv, options: ObserveOptions): ObserveSummary {
  const json = parseJson(options.input);
  if (json === undefined) {
    throw new Error("セルフレビューの結果を JSON として読めません。標準入力に JSON を1つ渡してください。");
  }
  const parsed = SelfReview.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join(".") || "(全体)"}: ${issue.message}`);
    throw new Error(`セルフレビューの結果の形が想定と違います。何も追記していません。\n${issues.join("\n")}`);
  }
  const review = parsed.data;
  const cwd = review.cwd ?? options.cwd;
  const repo = resolveRepo(cwd);
  if (repo === null) {
    throw new Error(
      `${cwd} のリポジトリが分かりません。何も追記していません。\ngit remote の origin があるリポジトリのフォルダで実行するか、JSON の cwd にそのフォルダを書いてください。`,
    );
  }
  const observations = selfReviewObservations(review, repo, cwd, options.now);
  const added = appendObservations(repoDir(arefineHome(env), repo), observations);
  return { repo, added: added.length, duplicates: observations.length - added.length };
}
