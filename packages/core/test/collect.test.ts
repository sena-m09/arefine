import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { collect } from "../src/pipeline/collect.ts";
import { repoFromRemoteUrl } from "../src/pipeline/repo.ts";

const Candidate = z.object({ text: z.string() });

function human(text: string, cwd: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid: randomUUID(),
    timestamp: "2026-11-01T10:00:00.000Z",
    sessionId: "s-1",
    cwd,
    origin: { kind: "human" },
    message: { role: "user", content: text },
  })}\n`;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "arefine-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const project = join(root, "claude", "projects", "-work-widget");
  mkdirSync(project, { recursive: true });

  const repoCwd = join(root, "widget");
  mkdirSync(repoCwd);
  execFileSync("git", ["init", "-q", repoCwd]);
  execFileSync("git", ["-C", repoCwd, "remote", "add", "origin", "git@github.com:acme/widget.git"]);

  return {
    root,
    home,
    env: { AREFINE_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude") },
    log: join(project, "s-1.jsonl"),
    repoCwd,
    candidateTexts: (repoDirName: string) =>
      readFileSync(join(home, repoDirName, "candidates.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => Candidate.parse(JSON.parse(line)).text),
  };
}

describe("arefine collect", () => {
  test("発話をリポジトリごとに保存し、リポジトリが分からない会話は _unknown にまとめる", () => {
    const { root, env, log, repoCwd, candidateTexts } = setup();
    appendFileSync(log, human("fetch を直接呼ばないで", repoCwd));
    appendFileSync(log, human("CLAUDE.md の書き方を直して", join(root, "deleted-worktree")));

    collect(env);

    expect(candidateTexts("acme__widget")).toEqual(["fetch を直接呼ばないで"]);
    expect(candidateTexts("_unknown")).toEqual(["CLAUDE.md の書き方を直して"]);
  });

  test("2回目は前回より後に書かれた発話だけを取り出す", () => {
    const { env, log, repoCwd, candidateTexts } = setup();
    appendFileSync(log, human("1つ目", repoCwd));
    collect(env);
    appendFileSync(log, human("2つ目", repoCwd));

    const summary = collect(env);

    expect(summary.candidates).toBe(1);
    expect(candidateTexts("acme__widget")).toEqual(["1つ目", "2つ目"]);
  });

  test("書き込み途中の行は、書き終わってから取り出す", () => {
    const { env, log, repoCwd, candidateTexts } = setup();
    const line = human("途中で読まれた発話", repoCwd);
    appendFileSync(log, line.slice(0, 40));
    expect(collect(env).candidates).toBe(0);

    appendFileSync(log, line.slice(40));
    collect(env);

    expect(candidateTexts("acme__widget")).toEqual(["途中で読まれた発話"]);
  });

  test("読み込み位置の記録が壊れていたら、発話を重複して追記する前に止める", () => {
    const { home, env, log, repoCwd, candidateTexts } = setup();
    appendFileSync(log, human("1つ目", repoCwd));
    collect(env);
    writeFileSync(join(home, "cursors.json"), "{ broken");

    expect(() => collect(env)).toThrow("cursors.json を読めません");
    expect(candidateTexts("acme__widget")).toEqual(["1つ目"]);
  });
});

describe("remote の URL からリポジトリ名を得る", () => {
  test.each([
    ["git@github.com:acme/widget.git"],
    ["https://github.com/acme/widget.git"],
    ["https://github.com/acme/widget"],
    ["ssh://git@github.com/acme/widget.git"],
  ])("%s は acme/widget になる", (url) => {
    expect(repoFromRemoteUrl(url)).toBe("acme/widget");
  });
});
