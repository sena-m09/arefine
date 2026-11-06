import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Llm } from "../llm/claude.ts";
import type { Budget } from "./budget.ts";
import { Candidate } from "./collect.ts";
import { parseJson, readNewLineEntries } from "./jsonl.ts";
import type { LineEntry } from "./jsonl.ts";
import { observationsFile, readObservations } from "./observation.ts";
import type { Observation } from "./observation.ts";
import { readProgress, writeProgress } from "./progress.ts";

const BATCH_SIZE = 20;
const MAX_TEXT_LENGTH = 2000;

const SYSTEM_PROMPT = `あなたは、人間とコーディングエージェント（AI）の会話から、人間が AI に出した修正指示を拾う係です。

入力は、人間の発話と AskUserQuestion への回答の一覧（JSON）です。
それぞれについて、AI の作業の進め方・書いたコード・書いた文章への修正指示や指摘、今後も守ってほしい方針が含まれているかを判断してください。

- 含まれているものだけを observations に入れます。1 つの発話に別々の指示が複数あれば、指示ごとに分けます
- 新しい作業の依頼、質問への答えとしての事実、了承の返事（「OK」「お願い」など）、雑談は入れません
- summary は、指示の中身を「〜しない」「〜する」の形で、会話を知らない人が読んでも分かる日本語の 1 文にします
- 発話に書かれていないことは推測で足しません`;

const NormalizeOutput = z.object({
  observations: z.array(z.object({ candidate_id: z.string(), summary: z.string().min(1) })),
});

export type NormalizeResult = {
  candidates: number;
  observations: number;
  pending: number;
  costUsd: number;
  error: string | null;
};

type BatchResult = { ok: true; observations: Observation[]; costUsd: number } | { ok: false; error: string; costUsd: number };

export function normalizeRepo(
  dir: string,
  repo: string,
  llm: Llm,
  budget: Budget,
  onBatch: (done: number, total: number) => void = () => {},
): NormalizeResult {
  const file = join(dir, "candidates.jsonl");
  if (!existsSync(file)) {
    return { candidates: 0, observations: 0, pending: 0, costUsd: 0, error: null };
  }
  const progress = readProgress(dir);
  const entries = readNewLineEntries(file, progress.normalized).entries.filter((entry) => entry.text.trim() !== "");
  const batches = chunk(entries, BATCH_SIZE);
  const known = new Set(readObservations(dir).map((observation) => observation.id));

  const done: { size: number; observations: number; costUsd: number }[] = [];
  const failures: string[] = [];
  for (const [i, batch] of batches.entries()) {
    if (budget.exhausted) {
      break;
    }
    onBatch(i * BATCH_SIZE, entries.length);
    const result = normalizeBatch(batch, repo, llm, budget.limitUsd);
    budget.charge(result.costUsd);
    if (!result.ok) {
      failures.push(result.error);
      done.push({ size: 0, observations: 0, costUsd: result.costUsd });
      break;
    }
    const fresh = result.observations.filter((observation) => !known.has(observation.id));
    appendFileSync(observationsFile(dir), fresh.map((observation) => `${JSON.stringify(observation)}\n`).join(""));
    for (const observation of fresh) {
      known.add(observation.id);
    }
    writeProgress(dir, { ...readProgress(dir), normalized: batch.at(-1)?.end ?? progress.normalized });
    done.push({ size: batch.length, observations: fresh.length, costUsd: result.costUsd });
  }

  const processed = done.reduce((sum, batch) => sum + batch.size, 0);
  return {
    candidates: processed,
    observations: done.reduce((sum, batch) => sum + batch.observations, 0),
    pending: entries.length - processed,
    costUsd: done.reduce((sum, batch) => sum + batch.costUsd, 0),
    error: failures[0] ?? null,
  };
}

function normalizeBatch(batch: LineEntry[], repo: string, llm: Llm, maxBudgetUsd: number): BatchResult {
  const candidates = batch.flatMap((entry) => {
    const candidate = Candidate.safeParse(parseJson(entry.text));
    return candidate.success ? [candidate.data] : [];
  });
  if (candidates.length === 0) {
    return { ok: true, observations: [], costUsd: 0 };
  }
  const result = llm({
    system: SYSTEM_PROMPT,
    prompt: JSON.stringify(
      candidates.map((candidate) => ({ id: candidate.id, kind: candidate.kind, text: truncate(candidate.text) })),
      null,
      2,
    ),
    schema: z.toJSONSchema(NormalizeOutput),
    maxBudgetUsd,
  });
  if (!result.ok) {
    return result;
  }
  const output = NormalizeOutput.safeParse(result.output);
  if (!output.success) {
    return { ok: false, error: "normalize の LLM の出力が想定した形式ではありません", costUsd: result.costUsd };
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const observations = [...Map.groupBy(output.data.observations, (item) => item.candidate_id)].flatMap(
    ([candidateId, items]) => {
      const candidate = byId.get(candidateId);
      if (candidate === undefined) {
        return [];
      }
      return items.map(
        (item, i): Observation => ({
          id: `obs_${candidate.id}_${i + 1}`,
          at: candidate.at,
          source: candidate.source,
          repo,
          cwd: candidate.cwd,
          guidance_id: null,
          summary: item.summary,
          ref: { candidate: candidate.id, session: candidate.ref.session, log: candidate.ref.log },
        }),
      );
    },
  );
  return { ok: true, observations, costUsd: result.costUsd };
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…（以下省略）` : text;
}

export function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
