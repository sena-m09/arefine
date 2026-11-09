import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseJson, readNewLines } from "./jsonl.ts";

const ReportEntry = z.object({ at: z.string(), report: z.string(), proposals: z.number() });
type ReportEntry = z.infer<typeof ReportEntry>;

const ReadMark = z.object({ read_until: z.string() });

export type Unread = { proposals: number; reports: string[]; newestAt: string | null };

export function reportIndexFile(dir: string): string {
  return join(dir, "reports", "index.jsonl");
}

export function readMarkFile(dir: string): string {
  return join(dir, "reports", "read.json");
}

export function recordReport(dir: string, entry: ReportEntry): void {
  const file = reportIndexFile(dir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function unread(dir: string): Unread {
  const readUntil = readMark(dir);
  const entries = reportEntries(dir).filter((entry) => readUntil === null || Date.parse(entry.at) > readUntil);
  return {
    proposals: entries.reduce((sum, entry) => sum + entry.proposals, 0),
    reports: [...new Set(entries.toReversed().map((entry) => entry.report))],
    newestAt: entries.reduce<string | null>(
      (newest, entry) => (newest === null || Date.parse(entry.at) > Date.parse(newest) ? entry.at : newest),
      null,
    ),
  };
}

// ack と同時に動いていた run の提案まで既読にしないよう、いまの時刻でなく最新の at を書く
export function markRead(dir: string): Unread {
  const pending = unread(dir);
  if (pending.newestAt !== null) {
    writeFileSync(readMarkFile(dir), `${JSON.stringify({ read_until: pending.newestAt })}\n`);
  }
  return pending;
}

function reportEntries(dir: string): ReportEntry[] {
  const file = reportIndexFile(dir);
  if (!existsSync(file)) {
    return [];
  }
  return readNewLines(file, 0).lines.flatMap((line) => {
    const entry = ReportEntry.safeParse(parseJson(line));
    return entry.success && !Number.isNaN(Date.parse(entry.data.at)) ? [entry.data] : [];
  });
}

function readMark(dir: string): number | null {
  const file = readMarkFile(dir);
  if (!existsSync(file)) {
    return null;
  }
  const mark = ReadMark.safeParse(parseJson(readFileSync(file, "utf8")));
  if (!mark.success) {
    return null;
  }
  const time = Date.parse(mark.data.read_until);
  return Number.isNaN(time) ? null : time;
}
