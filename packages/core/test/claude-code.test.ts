import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { parseLine, readSessionLog } from "../src/sources/claude-code.ts";

const fixture = new URL("./fixtures/claude-code/session.jsonl", import.meta.url);

const humanRecord = {
  type: "user",
  uuid: "u-1",
  timestamp: "2026-11-01T10:00:00.000Z",
  sessionId: "s-1",
  cwd: "/home/user/example",
  origin: { kind: "human" },
  message: { role: "user", content: "直して" },
};

describe("Claude Code のセッションログ", () => {
  test("人間が打った発話と AskUserQuestion への回答だけを取り出し、ツールの結果・hook・通知・サブエージェント・slash command は含めない", () => {
    const lines = readFileSync(fixture, "utf8").trim().split("\n");

    const utterances = lines.flatMap((line) => {
      const parsed = parseLine(line);
      return parsed.kind === "utterance" ? [{ kind: parsed.utterance.kind, text: parsed.utterance.text }] : [];
    });

    expect(utterances).toEqual([
      { kind: "prompt", text: "コンポーネントで fetch を直接呼ばないで" },
      { kind: "prompt", text: '<pasted_content id="ab12">\nエラーログ\n</pasted_content>\nこれを直して' },
      { kind: "prompt", text: "この余白を詰めて" },
      {
        kind: "answer",
        text: "質問: テストツールはどれにしますか？\n回答: vitest\nメモ: 既存プロジェクトと揃えて\n\n質問: lint はどれにしますか？\n回答: ESLint は使わない",
      },
    ]);
  });

  test("人間の発話でも形式が想定と違うものは取り出さず、読めなかったものとして区別する", () => {
    const readable = parseLine(JSON.stringify(humanRecord));
    const changed = parseLine(JSON.stringify({ ...humanRecord, message: { content: 42 } }));

    expect(readable.kind).toBe("utterance");
    expect(changed.kind).toBe("unreadable");
  });

  test("発話に、直前の AI の出力・直後の AI の出力・次の人の発話を付け、考えている途中の文と API エラーは含めない", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    writeFileSync(
      log,
      [
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "テストを書いて" } },
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "どこに置くか考える" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "テストを書きました。" }] } },
        { type: "assistant", isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error: Can't reach the API server" }] } },
        { ...meta, type: "user", uuid: "u-2", origin: { kind: "human" }, message: { content: "テスト名を日本語にして" } },
        { type: "assistant", message: { content: [{ type: "text", text: "直します" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "直しました" }] } },
        { ...meta, type: "user", uuid: "u-3", origin: { kind: "human" }, message: { content: "ありがとう" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const turns = readSessionLog(log).turns.map((turn) => turn.utterance);

    expect(turns.find((turn) => turn.id === "u-2")?.context).toEqual({
      before: "テストを書きました。",
      commands: [],
      after: "直します\n直しました",
      next: "ありがとう",
    });
    expect(turns.find((turn) => turn.id === "u-3")?.context).toEqual({
      before: "直します\n直しました",
      commands: [],
      after: "",
      next: null,
    });
  });

  test("長い出力は、直前の AI の出力を末尾 700 字、直後の AI の出力を先頭 700 字、次の人の発話を先頭 300 字に切る", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    writeFileSync(
      log,
      [
        { type: "assistant", message: { content: [{ type: "text", text: `${"古".repeat(300)}${"前".repeat(700)}` }] } },
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "直して" } },
        { type: "assistant", message: { content: [{ type: "text", text: `${"後".repeat(700)}${"切".repeat(300)}` }] } },
        { ...meta, type: "user", uuid: "u-2", origin: { kind: "human" }, message: { content: `${"次".repeat(300)}${"余".repeat(10)}` } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const [turn] = readSessionLog(log).turns;

    expect(turn?.utterance.context).toEqual({
      before: "前".repeat(700),
      commands: [],
      after: "後".repeat(700),
      next: "次".repeat(300),
    });
  });

  test("直前の AI が実行した Bash のコマンドを、新しいほうから 3 件まで 1 件 500 字で残し、結果の返っていないコマンドも含める", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    const push = `git push --force origin main && ${"echo done; ".repeat(60)}`;
    writeFileSync(
      log,
      [
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "状態を見て" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-1", name: "Bash", input: { command: "git status" } }] } },
        { ...meta, type: "user", uuid: "u-2", origin: { kind: "human" }, message: { content: "push して" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-2", name: "Bash", input: { command: "bun run lint" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-3", name: "Bash", input: { command: "git add -A" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-4", name: "Read", input: { file_path: "/home/user/example/README.md" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-5", name: "Bash", input: { command: "git commit -m wip" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-6", name: "Bash", input: { command: push } }] } },
        { ...meta, type: "user", uuid: "u-3", origin: { kind: "human" }, message: { content: "待って、force push はしないで" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const turns = readSessionLog(log).turns.map((turn) => turn.utterance);

    expect(turns.find((turn) => turn.id === "u-3")?.context.commands).toEqual(["git add -A", "git commit -m wip", push.slice(0, 500)]);
  });

  test("発話の直前に動いた skill / agent と、セッションでそれまでに動いたものを新しい順に記録し、サブエージェントの中で動いたものは数えない。呼び直した skill は前に分かった置き場を引き継ぐ", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    writeFileSync(
      log,
      [
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "変更履歴をまとめて" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-1", name: "Skill", input: { skill: "changelog" } }] } },
        {
          type: "user",
          isMeta: true,
          sourceToolUseID: "t-1",
          message: { content: [{ type: "text", text: "Base directory for this skill: /home/user/.claude/skills/changelog\n\n# changelog" }] },
        },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-2", name: "Agent", input: { subagent_type: "Explore" } }] } },
        { type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "t-3", name: "Skill", input: { skill: "lint-fix" } }] } },
        { ...meta, type: "user", uuid: "u-2", origin: { kind: "human" }, message: { content: "日付順に並べて" } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-4", name: "Agent", input: { prompt: "日付を調べて" } }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-5", name: "Skill", input: { skill: "changelog" } }] } },
        { ...meta, type: "user", uuid: "u-3", origin: { kind: "human" }, message: { content: "ありがとう" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const turns = readSessionLog(log).turns.map((turn) => turn.utterance);

    expect(turns.find((turn) => turn.id === "u-2")?.invocations).toEqual({
      active: [
        { kind: "agent", name: "Explore", dir: null },
        { kind: "skill", name: "changelog", dir: "/home/user/.claude/skills/changelog" },
      ],
      recent: [
        { kind: "agent", name: "Explore", dir: null },
        { kind: "skill", name: "changelog", dir: "/home/user/.claude/skills/changelog" },
      ],
    });
    expect(turns.find((turn) => turn.id === "u-3")?.invocations).toEqual({
      active: [
        { kind: "skill", name: "changelog", dir: "/home/user/.claude/skills/changelog" },
        { kind: "agent", name: "general-purpose", dir: null },
      ],
      recent: [
        { kind: "skill", name: "changelog", dir: "/home/user/.claude/skills/changelog" },
        { kind: "agent", name: "general-purpose", dir: null },
        { kind: "agent", name: "Explore", dir: null },
      ],
    });
  });

  test("slash command で起動した skill は次の発話の直前に動いた skill にし、前の発話から見た次の発話には打った形のまま残す。組み込みのコマンドは数えない", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    writeFileSync(
      log,
      [
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "リリースの準備をして" } },
        { type: "assistant", message: { content: [{ type: "text", text: "準備します" }] } },
        {
          ...meta,
          type: "user",
          uuid: "u-2",
          message: { content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" },
        },
        {
          ...meta,
          type: "user",
          uuid: "u-3",
          origin: { kind: "human" },
          message: {
            content: "<command-message>release-notes</command-message>\n<command-name>/release-notes</command-name>\n<command-args>v2.3 の分</command-args>",
          },
        },
        { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /home/user/.claude/skills/release-notes" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "リリースノートを書きます" }] } },
        { ...meta, type: "user", uuid: "u-4", origin: { kind: "human" }, message: { content: "見出しは英語にして" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const turns = readSessionLog(log).turns.map((turn) => turn.utterance);

    expect(turns.map((turn) => turn.id)).toEqual(["u-1", "u-4"]);
    expect(turns[0]?.context).toEqual({ before: "", commands: [], after: "準備します", next: "/release-notes v2.3 の分" });
    expect(turns[1]?.context.before).toBe("リリースノートを書きます");
    expect(turns[1]?.invocations).toEqual({
      active: [{ kind: "skill", name: "release-notes", dir: "/home/user/.claude/skills/release-notes" }],
      recent: [{ kind: "skill", name: "release-notes", dir: "/home/user/.claude/skills/release-notes" }],
    });
  });

  test("発話への返答までに読み込まれていた指示ファイルを、本文を除いてパスと種別だけ記録し、compact より前に読み込んだものは含めない", () => {
    const dir = mkdtempSync(join(tmpdir(), "arefine-log-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const log = join(dir, "s-1.jsonl");
    const meta = { timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s-1", cwd: "/home/user/example" };
    writeFileSync(
      log,
      [
        { ...meta, type: "user", uuid: "u-1", origin: { kind: "human" }, message: { content: "lint を直して" } },
        {
          type: "attachment",
          attachment: {
            type: "instructions",
            files: [
              { path: "/home/user/.claude/CLAUDE.md", type: "User", content: "日本語で答える" },
              { path: "/home/user/example/AGENTS.md", type: "Project", content: "let を使わない" },
            ],
          },
        },
        { type: "assistant", message: { content: [{ type: "text", text: "直します" }] } },
        {
          type: "attachment",
          attachment: {
            type: "nested_memory",
            path: "/home/user/example/.claude/rules/tests.md",
            content: { path: "/home/user/example/.claude/rules/tests.md", type: "Project", content: "テスト名は日本語にする", isRule: true },
          },
        },
        { ...meta, type: "user", uuid: "u-2", origin: { kind: "human" }, message: { content: "テストも直して" } },
        { type: "assistant", message: { content: [{ type: "text", text: "直しました" }] } },
        { type: "system", subtype: "compact_boundary" },
        { ...meta, type: "user", uuid: "u-3", origin: { kind: "human" }, message: { content: "続けて" } },
        {
          type: "attachment",
          attachment: { type: "instructions", files: [{ path: "/home/user/.claude/CLAUDE.md", type: "User", content: "日本語で答える" }] },
        },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t-1", name: "Skill", input: { skill: "build" } }] } },
        {
          type: "user",
          isMeta: true,
          sourceToolUseID: "t-1",
          message: { content: [{ type: "text", text: "Base directory for this skill: /home/user/example/.claude/skills/build" }] },
        },
        { ...meta, type: "user", uuid: "u-4", origin: { kind: "human" }, message: { content: "終わり" } },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(""),
    );

    const turns = readSessionLog(log).turns.map((turn) => turn.utterance);

    expect(turns.map((turn) => turn.instructions)).toEqual([
      [
        { path: "/home/user/.claude/CLAUDE.md", type: "User" },
        { path: "/home/user/example/AGENTS.md", type: "Project" },
      ],
      [
        { path: "/home/user/.claude/CLAUDE.md", type: "User" },
        { path: "/home/user/example/AGENTS.md", type: "Project" },
        { path: "/home/user/example/.claude/rules/tests.md", type: "Project" },
      ],
      [{ path: "/home/user/.claude/CLAUDE.md", type: "User" }],
      [
        { path: "/home/user/.claude/CLAUDE.md", type: "User" },
        { path: "/home/user/example/.claude/skills/build/SKILL.md", type: "Skill" },
      ],
    ]);
  });
});
