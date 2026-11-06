import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseLine } from "../src/sources/claude-code.ts";

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
});
