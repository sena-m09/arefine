import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function arefine(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
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
});
