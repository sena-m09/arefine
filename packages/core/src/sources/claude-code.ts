import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../pipeline/jsonl.ts";

export type Utterance = {
  id: string;
  at: string;
  session: string;
  cwd: string;
  text: string;
};

export type ParsedLine =
  | { kind: "utterance"; utterance: Utterance }
  | { kind: "unreadable" }
  | { kind: "skip" };

const HumanMarker = z.object({
  type: z.literal("user"),
  origin: z.object({ kind: z.literal("human") }),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
});

const HumanRecord = z.object({
  uuid: z.string(),
  timestamp: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  message: z.object({
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]),
  }),
});

export function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
}

export function listSessionLogs(projectsDir: string): string[] {
  return readdirOrEmpty(projectsDir).flatMap((project) => {
    const dir = join(projectsDir, project);
    return readdirOrEmpty(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name));
  });
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function parseLine(line: string): ParsedLine {
  const value = parseJson(line);
  const marker = HumanMarker.safeParse(value);
  if (!marker.success || marker.data.isMeta || marker.data.isSidechain) {
    return { kind: "skip" };
  }

  const record = HumanRecord.safeParse(value);
  if (!record.success) {
    return { kind: "unreadable" };
  }

  const { content } = record.data.message;
  const text = (
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n")
  ).trim();
  if (text === "" || text.startsWith("<command-")) {
    return { kind: "skip" };
  }

  return {
    kind: "utterance",
    utterance: {
      id: record.data.uuid,
      at: record.data.timestamp,
      session: record.data.sessionId,
      cwd: record.data.cwd,
      text,
    },
  };
}
