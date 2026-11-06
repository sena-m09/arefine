import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Utterance = {
  id: string;
  at: string;
  session: string;
  cwd: string;
  text: string;
};

type ContentBlock = { type?: string; text?: string };

type SessionRecord = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  origin?: { kind?: string } | null;
  message?: { content?: string | ContentBlock[] };
};

export function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
}

export function listSessionLogs(projectsDir: string): string[] {
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return [];
  }
  return projects.flatMap((project) => {
    const dir = join(projectsDir, project);
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  });
}

export function toUtterance(value: unknown): Utterance | undefined {
  const record = value as SessionRecord;
  if (record.type !== "user" || record.isMeta || record.isSidechain) {
    return undefined;
  }
  if (record.origin?.kind !== "human") {
    return undefined;
  }
  const text = textOf(record.message?.content).trim();
  if (text === "" || text.startsWith("<command-")) {
    return undefined;
  }
  if (!record.uuid || !record.timestamp || !record.sessionId || !record.cwd) {
    return undefined;
  }
  return {
    id: record.uuid,
    at: record.timestamp,
    session: record.sessionId,
    cwd: record.cwd,
    text,
  };
}

function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
