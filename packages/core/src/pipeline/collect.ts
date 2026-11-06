import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arefineHome, repoDir } from "../config/paths.ts";
import { claudeProjectsDir, listSessionLogs, toUtterance } from "../sources/claude-code.ts";
import { readNewRecords } from "./jsonl.ts";
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

type Cursors = Record<string, number>;

export type CollectSummary = {
  logs: number;
  candidates: number;
};

export function collect(env: NodeJS.ProcessEnv): CollectSummary {
  const home = arefineHome(env);
  const cursorsFile = join(home, "cursors.json");
  const cursors = readCursors(cursorsFile);
  const repoByCwd = new Map<string, string | null>();
  const summary: CollectSummary = { logs: 0, candidates: 0 };

  for (const log of listSessionLogs(claudeProjectsDir(env))) {
    const offset = cursors[log] ?? 0;
    const { records, nextOffset } = readNewRecords(log, offset);
    if (nextOffset === offset) {
      continue;
    }
    summary.logs += 1;

    for (const record of records) {
      const utterance = toUtterance(record);
      if (!utterance) {
        continue;
      }
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
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Cursors;
  } catch {
    return {};
  }
}

function writeCursors(file: string, cursors: Cursors): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursors, null, 2)}\n`);
  renameSync(tmp, file);
}
