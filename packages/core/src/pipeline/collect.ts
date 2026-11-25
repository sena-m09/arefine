import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { arefineHome, repoDir } from "../config/paths.ts";
import { claudeProjectsDir, listSessionLogs, readSessionLog } from "../sources/claude-code.ts";
import type { InstructionFile, TurnContext, Utterance, UtteranceKind } from "../sources/claude-code.ts";
import { parseJson } from "./jsonl.ts";
import { Invocations } from "./observation.ts";
import { writeJsonAtomic } from "./progress.ts";
import { resolveRepo } from "./repo.ts";

export const Candidate = z.object({
  id: z.string(),
  kind: z.enum(["prompt", "answer"]) satisfies z.ZodType<UtteranceKind>,
  at: z.string(),
  source: z.literal("claude-session"),
  repo: z.string().nullable(),
  cwd: z.string(),
  text: z.string(),
  ref: z.object({ session: z.string(), log: z.string() }),
  context: z
    .object({ before: z.string(), commands: z.array(z.string()), after: z.string(), next: z.string().nullable() })
    .optional() satisfies z.ZodType<TurnContext | undefined>,
  invocations: Invocations.optional(),
  instructions: z
    .array(z.object({ path: z.string(), type: z.string() }))
    .optional() satisfies z.ZodType<InstructionFile[] | undefined>,
});
export type Candidate = z.infer<typeof Candidate>;

const QUIET_MS = 30 * 60 * 1000;

const Cursors = z.record(z.string(), z.number().int().nonnegative());
type Cursors = z.infer<typeof Cursors>;

export type CollectSummary = {
  logs: number;
  candidates: number;
  unreadable: number;
};

type LogDelta = {
  log: string;
  nextOffset: number;
  utterances: Utterance[];
  unreadable: number;
};

export function collect(env: NodeJS.ProcessEnv, now: Date = new Date()): CollectSummary {
  const home = arefineHome(env);
  const cursorsFile = join(home, "cursors.json");
  const cursors = readCursors(cursorsFile);

  const deltas = listSessionLogs(claudeProjectsDir(env))
    .flatMap((log) => {
      const offset = cursors[log] ?? 0;
      const size = statSync(log).size;
      return size === offset ? [] : [readLogDelta(log, size < offset ? 0 : offset, now)];
    })
    .filter((delta) => delta.nextOffset !== (cursors[delta.log] ?? 0));

  const utterances = deltas.flatMap((delta) => delta.utterances.map((utterance) => ({ utterance, log: delta.log })));
  const repoByCwd = new Map(
    [...new Set(utterances.map(({ utterance }) => utterance.cwd))].map((cwd) => [cwd, resolveRepo(cwd)]),
  );
  const candidates = utterances.map(({ utterance, log }) =>
    toCandidate(utterance, log, repoByCwd.get(utterance.cwd) ?? null),
  );

  const written: Candidate[] = [];
  for (const [dir, group] of Map.groupBy(candidates, (candidate) => repoDir(home, candidate.repo))) {
    const fresh = unseen(dir, group);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "candidates.jsonl"), fresh.map((candidate) => `${JSON.stringify(candidate)}\n`).join(""));
    written.push(...fresh);
  }
  writeCursors(cursorsFile, {
    ...cursors,
    ...Object.fromEntries(deltas.map((delta) => [delta.log, delta.nextOffset])),
  });

  return {
    logs: deltas.length,
    candidates: written.length,
    unreadable: deltas.reduce((sum, delta) => sum + delta.unreadable, 0),
  };
}

function unseen(dir: string, group: Candidate[]): Candidate[] {
  const file = join(dir, "candidates.jsonl");
  const existing = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line) => {
          const candidate = Candidate.safeParse(parseJson(line));
          return candidate.success ? [candidate.data] : [];
        })
    : [];
  const seen = new Set(existing.flatMap(sameUtteranceKeys));
  return group.filter((candidate) => {
    const keys = sameUtteranceKeys(candidate);
    if (keys.some((key) => seen.has(key))) {
      return false;
    }
    for (const key of keys) {
      seen.add(key);
    }
    return true;
  });
}

function sameUtteranceKeys(candidate: Candidate): string[] {
  return [`id:${candidate.id}`, `text:${candidate.ref.session}:${candidate.text}`];
}

function readLogDelta(log: string, offset: number, now: Date): LogDelta {
  const session = readSessionLog(log);
  const lastAt = Date.parse(session.lastAt ?? "");
  const quiet = Number.isNaN(lastAt) || now.getTime() - lastAt >= QUIET_MS;
  const fresh = session.turns.filter((turn) => turn.start >= offset);
  const nextOffset = (quiet ? undefined : fresh.find((turn) => !turn.answered))?.start ?? session.end;
  return {
    log,
    nextOffset,
    utterances: fresh.filter((turn) => turn.start < nextOffset).map((turn) => turn.utterance),
    unreadable: session.unreadableStarts.filter((start) => start >= offset && start < nextOffset).length,
  };
}

function toCandidate(utterance: Utterance, log: string, repo: string | null): Candidate {
  return {
    id: utterance.id,
    kind: utterance.kind,
    at: utterance.at,
    source: "claude-session",
    repo,
    cwd: utterance.cwd,
    text: utterance.text,
    ref: { session: utterance.session, log },
    context: utterance.context,
    invocations: utterance.invocations,
    instructions: utterance.instructions,
  };
}

function readCursors(file: string): Cursors {
  if (!existsSync(file)) {
    return {};
  }
  const cursors = Cursors.safeParse(parseJson(readFileSync(file, "utf8")));
  if (!cursors.success) {
    throw new Error(
      `${file} を読めません。\nこのファイルを削除すると、セッションログを最初から読み直します。そのときは、取り出し済みの発話が candidates.jsonl に重複して追記されます。`,
    );
  }
  return cursors.data;
}

function writeCursors(file: string, cursors: Cursors): void {
  writeJsonAtomic(file, cursors);
}
