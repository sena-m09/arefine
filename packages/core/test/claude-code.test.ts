import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { toUtterance } from "../src/sources/claude-code.ts";

const fixture = new URL("./fixtures/claude-code/session.jsonl", import.meta.url);

describe("Claude Code のセッションログ", () => {
  test("人間が打った発話だけを取り出し、ツールの結果・hook・通知・サブエージェント・slash command は含めない", () => {
    const records: unknown[] = readFileSync(fixture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const texts = records.flatMap((record) => toUtterance(record)?.text ?? []);

    expect(texts).toEqual([
      "コンポーネントで fetch を直接呼ばないで",
      '<pasted_content id="ab12">\nエラーログ\n</pasted_content>\nこれを直して',
      "この余白を詰めて",
    ]);
  });
});
