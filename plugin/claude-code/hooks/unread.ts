import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOWN_REPORTS = 3;

export type Unread = { proposals: number; reports: string[] };

type ReportEntry = { at: number; report: string; proposals: number };

export function sessionStartOutput(input: string, env: NodeJS.ProcessEnv, fallbackCwd: string): string | null {
  const repo = resolveRepo(cwdOf(parseJson(input)) ?? fallbackCwd);
  if (repo === null) {
    return null;
  }
  const pending = findUnread(join(env["AREFINE_HOME"] ?? join(homedir(), ".arefine"), repo.replace("/", "__")));
  if (pending.proposals === 0) {
    return null;
  }
  const reports = listReports(pending.reports);
  return JSON.stringify({
    systemMessage: `aRefine: ${repo} にまだ読んでいない提案が ${pending.proposals} 件あります。\n${reports}\n読んだら arefine ack を実行してください。`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `aRefine（セッションログから改善提案を出すツール）が、このリポジトリ（${repo}）にまだ読んでいない提案を ${pending.proposals} 件出しています。\n${reports}\n利用者に聞かれたときだけ触れてください。利用者が提案を読み終えたと言ったら、arefine ack を実行してください。`,
    },
  });
}

export function findUnread(dir: string): Unread {
  const readUntil = readMark(join(dir, "reports", "read.json"));
  const entries = reportEntries(join(dir, "reports", "index.jsonl")).filter(
    (entry) => readUntil === null || entry.at > readUntil,
  );
  return {
    proposals: entries.reduce((sum, entry) => sum + entry.proposals, 0),
    reports: [...new Set(entries.toReversed().map((entry) => entry.report))],
  };
}

export function repoFromRemoteUrl(url: string): string | null {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

function listReports(reports: string[]): string {
  const shown = reports.slice(0, SHOWN_REPORTS).map((report) => `レポート: ${report}`);
  const rest = reports.length - SHOWN_REPORTS;
  return [...shown, ...(rest > 0 ? [`ほかに ${rest} 件のレポートがあります。`] : [])].join("\n");
}

function resolveRepo(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return repoFromRemoteUrl(url.trim());
  } catch {
    return null;
  }
}

function cwdOf(input: unknown): string | null {
  return typeof input === "object" && input !== null && "cwd" in input && typeof input.cwd === "string"
    ? input.cwd
    : null;
}

function reportEntries(file: string): ReportEntry[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      const entry = reportEntry(parseJson(line));
      return entry === null ? [] : [entry];
    });
}

function reportEntry(value: unknown): ReportEntry | null {
  if (typeof value !== "object" || value === null || !("at" in value && "report" in value && "proposals" in value)) {
    return null;
  }
  const { at, report, proposals } = value;
  if (typeof at !== "string" || typeof report !== "string" || typeof proposals !== "number") {
    return null;
  }
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : { at: time, report, proposals };
}

function readMark(file: string): number | null {
  if (!existsSync(file)) {
    return null;
  }
  const value = parseJson(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || !("read_until" in value) || typeof value.read_until !== "string") {
    return null;
  }
  const time = Date.parse(value.read_until);
  return Number.isNaN(time) ? null : time;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
