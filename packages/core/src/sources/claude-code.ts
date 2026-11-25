import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseJson, readNewLineEntries } from "../pipeline/jsonl.ts";
import type { Invocation, Invocations } from "../pipeline/observation.ts";

export type UtteranceKind = "prompt" | "answer";

export type UtteranceRecord = {
  id: string;
  kind: UtteranceKind;
  at: string;
  session: string;
  cwd: string;
  text: string;
};

export type TurnContext = { before: string; commands: string[]; after: string; next: string | null };

export type InstructionFile = { path: string; type: string };

export type Utterance = UtteranceRecord & {
  context: TurnContext;
  invocations: Invocations;
  instructions: InstructionFile[];
};

export type SessionTurn = {
  utterance: Utterance;
  start: number;
  answered: boolean;
};

export type SessionLog = {
  turns: SessionTurn[];
  unreadableStarts: number[];
  end: number;
  lastAt: string | null;
};

type ToolUse = { id: string; name: string; input: unknown };

export type ParsedLine =
  | { kind: "utterance"; utterance: UtteranceRecord }
  | { kind: "unreadable" }
  | { kind: "slash"; name: string; args: string }
  | { kind: "skill-body"; dir: string; toolUseId: string | null }
  | { kind: "assistant"; text: string; tools: ToolUse[] }
  | { kind: "instructions"; files: InstructionFile[] }
  | { kind: "compact" }
  | { kind: "skip" };

type Event = { start: number; line: ParsedLine };

const BEFORE_LENGTH = 700;
const AFTER_LENGTH = 700;
const NEXT_LENGTH = 300;
const COMMAND_COUNT = 3;
const COMMAND_LENGTH = 500;
const RECENT_COUNT = 6;
const SKILL_BODY_PREFIX = "Base directory for this skill:";

const RecordMeta = z.object({
  uuid: z.string(),
  timestamp: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
});

const Timestamped = z.object({ timestamp: z.string() });

const Sidechain = z.object({ isSidechain: z.literal(true) });

const Content = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]);

const PromptMarker = z.object({
  type: z.literal("user"),
  origin: z.object({ kind: z.literal("human") }),
  isMeta: z.boolean().optional(),
});

const PromptRecord = RecordMeta.extend({
  message: z.object({ content: Content }),
});

const AnswerMarker = z.object({
  type: z.literal("user"),
  toolUseResult: z.object({ questions: z.unknown(), answers: z.unknown() }),
});

const AnswerRecord = RecordMeta.extend({
  toolUseResult: z.object({
    questions: z.array(z.object({ question: z.string() })),
    answers: z.record(z.string(), z.string()),
    annotations: z.record(z.string(), z.object({ notes: z.string().optional() })).optional(),
  }),
});

const SkillBodyRecord = z.object({
  type: z.literal("user"),
  isMeta: z.literal(true),
  sourceToolUseID: z.string().optional(),
  message: z.object({ content: Content }),
});

const AssistantRecord = z.object({
  type: z.literal("assistant"),
  isApiErrorMessage: z.boolean().optional(),
  message: z.object({
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
      }),
    ),
  }),
});

const InstructionsAttachment = z.object({
  type: z.literal("attachment"),
  attachment: z.object({
    type: z.literal("instructions"),
    files: z.array(z.object({ path: z.string(), type: z.string() })),
  }),
});

const NestedMemoryAttachment = z.object({
  type: z.literal("attachment"),
  attachment: z.object({
    type: z.literal("nested_memory"),
    path: z.string(),
    content: z.object({ type: z.string() }),
  }),
});

const CompactBoundary = z.object({ type: z.literal("system"), subtype: z.literal("compact_boundary") });

const BashInput = z.object({ command: z.string() });
const SkillInput = z.object({ skill: z.string() });
const AgentInput = z.object({ subagent_type: z.string().optional() });

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
  return parseRecord(parseJson(line));
}

export function readSessionLog(file: string): SessionLog {
  const { entries, nextOffset } = readNewLineEntries(file, 0);
  const records = entries.map((entry, i) => {
    const value = parseJson(entry.text);
    return { start: entries[i - 1]?.end ?? 0, line: parseRecord(value), at: Timestamped.safeParse(value).data?.timestamp };
  });
  const events: Event[] = records.filter((record) => record.line.kind !== "skip");
  const boundaries = events.flatMap((event, i) => (isBoundary(event.line) ? [i] : []));
  const nextBoundary = (i: number) => boundaries.find((b) => b > i) ?? events.length;
  const invocations = invocationsOf(events, nextBoundary);

  const turns = events.flatMap((event, i): SessionTurn[] => {
    if (event.line.kind !== "utterance") {
      return [];
    }
    const from = boundaries.findLast((b) => b < i) ?? 0;
    const next = nextBoundary(i);
    const nextLine = events[next]?.line;
    const invokedBefore = (lo: number) =>
      invocations.filter(({ index }) => index >= lo && index < i).map(({ invocation }) => invocation);
    return [
      {
        start: event.start,
        answered: nextLine !== undefined,
        utterance: {
          ...event.line.utterance,
          context: {
            before: assistantText(events.slice(from, i)).slice(-BEFORE_LENGTH),
            commands: bashCommands(events.slice(from, i))
              .slice(-COMMAND_COUNT)
              .map((command) => command.slice(0, COMMAND_LENGTH)),
            after: assistantText(events.slice(i + 1, next)).slice(0, AFTER_LENGTH),
            next: nextLine === undefined ? null : boundaryText(nextLine).slice(0, NEXT_LENGTH),
          },
          invocations: {
            active: newestFirst(invokedBefore(from)),
            recent: newestFirst(invokedBefore(0)).slice(0, RECENT_COUNT),
          },
          instructions: loadedInstructions(events, i),
        },
      },
    ];
  });

  return {
    turns,
    unreadableStarts: records.filter((record) => record.line.kind === "unreadable").map((record) => record.start),
    end: nextOffset,
    lastAt: records.findLast((record) => record.at !== undefined)?.at ?? null,
  };
}

function parseRecord(value: unknown): ParsedLine {
  if (Sidechain.safeParse(value).success) {
    return { kind: "skip" };
  }
  return (
    parsePrompt(value) ??
    parseAnswer(value) ??
    parseSkillBody(value) ??
    parseAssistant(value) ??
    parseAttachment(value) ??
    (CompactBoundary.safeParse(value).success ? { kind: "compact" } : { kind: "skip" })
  );
}

function parsePrompt(value: unknown): ParsedLine | null {
  const marker = PromptMarker.safeParse(value);
  if (!marker.success || marker.data.isMeta) {
    return null;
  }
  const record = PromptRecord.safeParse(value);
  if (!record.success) {
    return { kind: "unreadable" };
  }
  const text = textOf(record.data.message.content).trim();
  if (text.startsWith("<command-")) {
    return parseSlash(text);
  }
  if (text === "") {
    return { kind: "skip" };
  }
  return toUtterance(record.data, "prompt", text);
}

function parseSlash(text: string): ParsedLine {
  const name = /<command-name>\/?([^<]+)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name === undefined) {
    return { kind: "skip" };
  }
  return { kind: "slash", name, args: /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "" };
}

function parseAnswer(value: unknown): ParsedLine | null {
  if (!AnswerMarker.safeParse(value).success) {
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

function parseSkillBody(value: unknown): ParsedLine | null {
  const record = SkillBodyRecord.safeParse(value);
  if (!record.success) {
    return null;
  }
  const text = textOf(record.data.message.content);
  if (!text.startsWith(SKILL_BODY_PREFIX)) {
    return null;
  }
  const dir = (text.split("\n")[0] ?? "").slice(SKILL_BODY_PREFIX.length).trim();
  return { kind: "skill-body", dir, toolUseId: record.data.sourceToolUseID ?? null };
}

function parseAssistant(value: unknown): ParsedLine | null {
  const record = AssistantRecord.safeParse(value);
  if (!record.success || record.data.isApiErrorMessage) {
    return null;
  }
  const blocks = record.data.message.content;
  return {
    kind: "assistant",
    text: blocks
      .flatMap((block) => (block.type === "text" && block.text !== undefined && block.text.trim() !== "" ? [block.text.trim()] : []))
      .join("\n"),
    tools: blocks.flatMap((block) =>
      block.type === "tool_use" && block.id !== undefined && block.name !== undefined
        ? [{ id: block.id, name: block.name, input: block.input }]
        : [],
    ),
  };
}

function parseAttachment(value: unknown): ParsedLine | null {
  const instructions = InstructionsAttachment.safeParse(value);
  if (instructions.success) {
    return { kind: "instructions", files: instructions.data.attachment.files };
  }
  const nested = NestedMemoryAttachment.safeParse(value);
  if (nested.success) {
    return { kind: "instructions", files: [{ path: nested.data.attachment.path, type: nested.data.attachment.content.type }] };
  }
  return null;
}

function textOf(content: z.infer<typeof Content>): string {
  return typeof content === "string"
    ? content
    : content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
}

function toUtterance(meta: z.infer<typeof RecordMeta>, kind: UtteranceKind, text: string): ParsedLine {
  return {
    kind: "utterance",
    utterance: { id: meta.uuid, kind, at: meta.timestamp, session: meta.sessionId, cwd: meta.cwd, text },
  };
}

function isBoundary(line: ParsedLine): boolean {
  return line.kind === "utterance" || line.kind === "slash";
}

function boundaryText(line: ParsedLine): string {
  if (line.kind === "utterance") {
    return line.utterance.text;
  }
  if (line.kind === "slash") {
    return line.args === "" ? `/${line.name}` : `/${line.name} ${line.args}`;
  }
  return "";
}

function assistantText(events: Event[]): string {
  return events.flatMap(({ line }) => (line.kind === "assistant" && line.text !== "" ? [line.text] : [])).join("\n");
}

function bashCommands(events: Event[]): string[] {
  return events.flatMap(({ line }) =>
    line.kind === "assistant"
      ? line.tools.flatMap((tool) => {
          const input = BashInput.safeParse(tool.input);
          return tool.name === "Bash" && input.success ? [input.data.command] : [];
        })
      : [],
  );
}

function invocationsOf(events: Event[], nextBoundary: (i: number) => number): { index: number; invocation: Invocation }[] {
  const skillDirs = new Map(
    events.flatMap(({ line }) => (line.kind === "skill-body" && line.toolUseId !== null ? [[line.toolUseId, line.dir] as const] : [])),
  );
  return events.flatMap(({ line }, index) => {
    if (line.kind === "assistant") {
      return line.tools.flatMap((tool) => toolInvocation(tool, skillDirs)).map((invocation) => ({ index, invocation }));
    }
    if (line.kind === "slash") {
      const dir = events
        .slice(index + 1, nextBoundary(index))
        .flatMap((event) => (event.line.kind === "skill-body" && event.line.toolUseId === null ? [event.line.dir] : []))[0];
      return dir === undefined ? [] : [{ index, invocation: { kind: "skill" as const, name: line.name, dir } }];
    }
    return [];
  });
}

function toolInvocation(tool: ToolUse, skillDirs: Map<string, string>): Invocation[] {
  if (tool.name === "Skill") {
    const input = SkillInput.safeParse(tool.input);
    return input.success ? [{ kind: "skill", name: input.data.skill, dir: skillDirs.get(tool.id) ?? null }] : [];
  }
  if (tool.name === "Agent" || tool.name === "Task") {
    const input = AgentInput.safeParse(tool.input);
    return input.success ? [{ kind: "agent", name: input.data.subagent_type ?? "general-purpose", dir: null }] : [];
  }
  return [];
}

function newestFirst(invocations: Invocation[]): Invocation[] {
  const reversed = invocations.toReversed();
  return reversed.filter(
    (invocation, i) => reversed.findIndex((other) => other.kind === invocation.kind && other.name === invocation.name) === i,
  );
}

function loadedInstructions(events: Event[], i: number): InstructionFile[] {
  const from = events.slice(0, i).findLastIndex(({ line }) => line.kind === "compact") + 1;
  const replyAt = events.findIndex(({ line }, j) => j > i && (line.kind === "assistant" || isBoundary(line)));
  const files = events.slice(from, replyAt === -1 ? events.length : replyAt).flatMap(({ line }): InstructionFile[] => {
    if (line.kind === "instructions") {
      return line.files;
    }
    if (line.kind === "skill-body") {
      return [{ path: join(line.dir, "SKILL.md"), type: "Skill" }];
    }
    return [];
  });
  return files.filter((file, j) => files.findIndex((other) => other.path === file.path) === j);
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
