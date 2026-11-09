import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Llm, LlmRequest } from "../src/llm/claude.ts";
import { readObservations } from "../src/pipeline/observation.ts";
import { observe } from "../src/pipeline/observe.ts";
import { run } from "../src/pipeline/run.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "arefine-observe-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const repo = join(root, "widget");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
  const notRepo = join(root, "scratch");
  mkdirSync(notRepo);
  mkdirSync(join(root, "claude", "projects"), { recursive: true });

  const env = { AREFINE_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude") };
  return {
    root,
    env,
    repo,
    notRepo,
    observe: (review: unknown, cwd = repo) =>
      observe(env, { input: JSON.stringify(review), cwd, now: new Date("2026-11-06T03:00:00.000Z") }),
    observations: () => readObservations(join(home, "acme__widget")),
  };
}

describe("arefine observe", () => {
  test("セルフレビューの指摘を、guidance ID と違反したコードごと、そのリポジトリの修正指示として残す", () => {
    const { observe, observations, repo } = setup();

    const summary = observe({
      session: "s-1",
      findings: [
        { guidance_id: "G-006", summary: "型アサーションを使わない", evidence: { violation: "const user = data as User;" } },
        { summary: "テスト名に実装の関数名を書かない" },
      ],
    });

    expect(summary).toEqual({ repo: "acme/widget", added: 2, duplicates: 0 });
    expect(observations()).toEqual([
      expect.objectContaining({
        source: "self-review",
        repo: "acme/widget",
        cwd: repo,
        guidance_id: "G-006",
        summary: "型アサーションを使わない",
        stated_as_rule: false,
        risk_kind: null,
        evidence: { violation: "const user = data as User;", fix: null },
      }),
      expect.objectContaining({ guidance_id: null, summary: "テスト名に実装の関数名を書かない" }),
    ]);
  });

  test("形の違う JSON は、どの項目が違うかを示して止め、何も残さない", () => {
    const { observe, observations } = setup();

    expect(() => observe({ session: "s-1", findings: [{ guidance_id: "[G-006]", summary: "型アサーションを使わない" }] })).toThrow(
      /findings\.0\.guidance_id: guidance ID は G-012 のように/,
    );
    expect(observations()).toEqual([]);
  });

  test("どのセッションでのレビューかが書かれていない JSON は、項目名を示して止め、何も残さない", () => {
    const { observe, observations } = setup();

    expect(() => observe({ findings: [{ guidance_id: "G-006", summary: "型アサーションを使わない" }] })).toThrow(/\n {2}session:/);
    expect(observations()).toEqual([]);
  });

  test("指摘のなかったセルフレビューは、何も残さずに正常に終わる", () => {
    const { observe, observations } = setup();

    expect(observe({ session: "s-1", findings: [] })).toEqual({ repo: "acme/widget", added: 0, duplicates: 0 });
    expect(observations()).toEqual([]);
  });

  test("同じ結果を2回渡しても1件のままで、別のセッションでの同じ指摘は別に数える", () => {
    const { observe, observations } = setup();
    const finding = { guidance_id: "G-006", summary: "型アサーションを使わない" };

    observe({ session: "s-1", findings: [finding] });
    const again = observe({ session: "s-1", findings: [finding] });
    observe({ session: "s-2", findings: [finding] });

    expect(again).toEqual({ repo: "acme/widget", added: 0, duplicates: 1 });
    expect(observations()).toHaveLength(2);
  });

  test("どのリポジトリか分からないフォルダの結果は、何も残さずに止める", () => {
    const { observe, notRepo, root } = setup();

    expect(() => observe({ session: "s-1", findings: [{ summary: "型アサーションを使わない" }] }, notRepo)).toThrow(
      `${notRepo} のリポジトリが分かりません。何も追記していません。`,
    );
    expect(readObservations(join(root, "home", "_unknown"))).toEqual([]);
  });

  test("セルフレビューの指摘しかないリポジトリも、run でセルフレビューを受け取る観点に渡す", () => {
    const { observe, env, root } = setup();
    observe({ session: "s-1", findings: [{ guidance_id: "G-006", summary: "型アサーションを使わない" }] });
    const refiners = join(root, "refiners");
    mkdirSync(join(refiners, "sample"), { recursive: true });
    writeFileSync(
      join(refiners, "sample", "refiner.yaml"),
      "name: sample\ndescription: テスト用の観点\ninputs: [self-review]\ndefault_enabled: false\n",
    );
    writeFileSync(join(refiners, "sample", "SKILL.md"), "# テスト用の観点\n");
    writeFileSync(join(root, "home", "config.yaml"), "refiners:\n  sample:\n    enabled: true\n");
    const calls: LlmRequest[] = [];
    const llm: Llm = (request) => {
      calls.push(request);
      return { ok: true, costUsd: 0.01, output: { proposals: [] } };
    };

    run(env, { llm, now: new Date(2026, 10, 6), builtinRefinersDir: refiners });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain('"summary":"型アサーションを使わない"');
  });

  test("コマンドとしては、標準入力の JSON を受け取り、追記した件数を表示する", () => {
    const { env, repo } = setup();

    const result = spawnSync(process.execPath, [cli, "observe"], {
      cwd: repo,
      encoding: "utf8",
      input: JSON.stringify({ session: "s-1", findings: [{ summary: "型アサーションを使わない" }] }),
      env: { ...process.env, ...env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("acme/widget に 1 件の修正指示を追記しました。\n");
  });
});
