import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../pipeline/jsonl.ts";

export type UtteranceKind = "prompt" | "answer";

export type Utterance = {
  id: string;
  kind: UtteranceKind;
  at: string;
  session: string;
  cwd: string;
  text: string;
};

export type ParsedLine =
  | { kind: "utterance"; utterance: Utterance }
  | { kind: "unreadable" }
  | { kind: "skip" };

const RecordMeta = z.object({
  uuid: z.string(),
  timestamp: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
});

const PromptMarker = z.object({
  type: z.literal("user"),
  origin: z.object({ kind: z.literal("human") }),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
});

const PromptRecord = RecordMeta.extend({
  message: z.object({
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]),
  }),
});

const AnswerMarker = z.object({
  type: z.literal("user"),
  isSidechain: z.boolean().optional(),
  toolUseResult: z.object({ questions: z.unknown(), answers: z.unknown() }),
});

const AnswerRecord = RecordMeta.extend({
  toolUseResult: z.object({
    questions: z.array(z.object({ question: z.string() })),
    answers: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.object({ notes: z.string().optional() })).optional(),
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

export function parseLine(line: string): ParsedLine {
  const value = parseJson(line);
  return parsePrompt(value) ?? parseAnswer(value) ?? { kind: "skip" };
}

function parsePrompt(value: unknown): ParsedLine | null {
  const marker = PromptMarker.safeParse(value);
  if (!marker.success || marker.data.isMeta || marker.data.isSidechain) {
    return null;
  }
  const record = PromptRecord.safeParse(value);
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
  return toUtterance(record.data, "prompt", text);
}

function parseAnswer(value: unknown): ParsedLine | null {
  const marker = AnswerMarker.safeParse(value);
  if (!marker.success || marker.data.isSidechain) {
    return null;
  }
  const record = AnswerRecord.safeParse(value);
  if (!record.success) {
    return { kind: "unreadable" };
  }
  const { questions, answers, annotations } = record.data.toolUseResult;
  const text = questions
    .flatMap(({ question }) => {
      const answer = answers[question];
      if (answer === undefined) {
        return [];
      }
      const notes = annotations?.[question]?.notes;
      return [[`質問: ${question}`, `回答: ${answer}`, ...(notes ? [`メモ: ${notes}`] : [])].join("\n")];
    })
    .join("\n\n");
  if (text === "") {
    return { kind: "skip" };
  }
  return toUtterance(record.data, "answer", text);
}

function toUtterance(meta: z.infer<typeof RecordMeta>, kind: UtteranceKind, text: string): ParsedLine {
  return {
    kind: "utterance",
    utterance: { id: meta.uuid, kind, at: meta.timestamp, session: meta.sessionId, cwd: meta.cwd, text },
  };
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
