import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { arefineHome, repoDir } from "../config/paths.ts";
import { claudeProjectsDir, listSessionLogs, parseLine } from "../sources/claude-code.ts";
import { parseJson, readNewLines } from "./jsonl.ts";
import { resolveRepo } from "./repo.ts";

export type Candidate = {
  id: string;
  at: string;
  source: "claude-session";
  repo: string | null;
  cwd: string;
  text: string;
  ref: { session: string; log: string };
};

const Cursors = z.record(z.string(), z.number().int().nonnegative());
type Cursors = z.infer<typeof Cursors>;

export type CollectSummary = {
  logs: number;
  candidates: number;
  unreadable: number;
};

export function collect(env: NodeJS.ProcessEnv): CollectSummary {
  const home = arefineHome(env);
  const cursorsFile = join(home, "cursors.json");
  const cursors = readCursors(cursorsFile);
  const repoByCwd = new Map<string, string | null>();
  const summary: CollectSummary = { logs: 0, candidates: 0, unreadable: 0 };

  for (const log of listSessionLogs(claudeProjectsDir(env))) {
    const offset = cursors[log] ?? 0;
    const { lines, nextOffset } = readNewLines(log, offset);
    if (nextOffset === offset) {
      continue;
    }
    summary.logs += 1;

    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.kind === "unreadable") {
        summary.unreadable += 1;
      }
      if (parsed.kind !== "utterance") {
        continue;
      }
      const { utterance } = parsed;
      if (!repoByCwd.has(utterance.cwd)) {
        repoByCwd.set(utterance.cwd, resolveRepo(utterance.cwd));
      }
      const repo = repoByCwd.get(utterance.cwd) ?? null;
      const candidate: Candidate = {
        id: utterance.id,
        at: utterance.at,
        source: "claude-session",
        repo,
        cwd: utterance.cwd,
        text: utterance.text,
        ref: { session: utterance.session, log },
      };
      const dir = repoDir(home, repo);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "candidates.jsonl"), `${JSON.stringify(candidate)}\n`);
      summary.candidates += 1;
    }
    cursors[log] = nextOffset;
  }

  writeCursors(cursorsFile, cursors);
  return summary;
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
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursors, null, 2)}\n`);
  renameSync(tmp, file);
}
