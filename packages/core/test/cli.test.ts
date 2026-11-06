import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function arefine(...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "arefine-cli-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, AREFINE_HOME: join(root, "home"), CLAUDE_CONFIG_DIR: join(root, "claude") },
  });
}

describe("arefine", () => {
  test("--help で使い方を表示して正常終了する", () => {
    const result = arefine("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("使い方:");
  });

  test("コマンドを付けずに実行すると使い方を表示する", () => {
    const result = arefine();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("使い方:");
  });

  test("知らないコマンドはエラー終了し、--help を案内する", () => {
    const result = arefine("unknown");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("不明なコマンドです: unknown");
    expect(result.stderr).toContain("arefine --help");
  });

  test("run は、観点を有効にしていなければ config.yaml の場所を示して止める", () => {
    const result = arefine("run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("有効な観点がないため、ここで止めました。");
    expect(result.stdout).toContain("config.yaml で観点を有効にしてください");
  });
});
