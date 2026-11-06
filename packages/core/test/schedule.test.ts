import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function setup(config?: string) {
  const root = mkdtempSync(join(tmpdir(), "arefine-schedule-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "arefine");
  mkdirSync(home);
  mkdirSync(join(root, "claude", "projects"), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(home, "config.yaml"), config);
  }
  const env = {
    ...process.env,
    HOME: join(root, "user"),
    AREFINE_HOME: home,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    PATH: "/opt/tools/bin:/usr/bin:/bin",
  };
  const plist = join(root, "user", "Library", "LaunchAgents", "com.github.sena-m09.arefine.run.plist");
  return {
    home,
    plist,
    arefine: (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env }),
    readPlist: () => readFileSync(plist, "utf8"),
  };
}

describe("arefine schedule", () => {
  test("毎日 run する plist を LaunchAgents に置き、登録と解除のコマンドを表示する", () => {
    const { arefine, plist, readPlist } = setup();

    const result = arefine("schedule");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`launchctl bootstrap gui/$(id -u) "${plist}"`);
    expect(result.stdout).toContain("launchctl bootout gui/$(id -u)/com.github.sena-m09.arefine.run");
    expect(readPlist()).toContain("<string>run</string>");
    expect(readPlist()).toMatch(/<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>/);
  });

  test("config.yaml で schedule: weekly にすると、週に1回だけ動く", () => {
    const { arefine, readPlist } = setup("schedule: weekly\n");

    arefine("schedule");

    expect(readPlist()).toMatch(/<key>Weekday<\/key>\s*<integer>1<\/integer>/);
  });

  test("launchd から起動しても claude と保存先が見つかるよう、いまの PATH と AREFINE_HOME を plist に書く", () => {
    const { arefine, home, readPlist } = setup();

    arefine("schedule");

    expect(readPlist()).toMatch(/<key>PATH<\/key>\s*<string>\/opt\/tools\/bin:\/usr\/bin:\/bin<\/string>/);
    expect(readPlist()).toMatch(new RegExp(`<key>AREFINE_HOME</key>\\s*<string>${home}</string>`));
  });

  test("schedule の値が違えば、どの項目かを示して止め、plist を書かない", () => {
    const { arefine, plist } = setup("schedule: hourly\n");

    const result = arefine("schedule");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("schedule:");
    expect(() => readFileSync(plist)).toThrow();
  });
});

describe("同時に動かさない", () => {
  test("別の arefine が動いている間は、何もせずに終わる", () => {
    const { arefine, home } = setup();
    writeFileSync(join(home, "run.lock"), `${process.pid}\n`);

    const result = arefine("collect");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`別の arefine（pid ${process.pid}）が動いているため、何もせずに終わります。`);
    expect(result.stdout).not.toContain("件のセッションログから");
  });

  test("前の arefine が途中で落ちてロックが残っていても、次の実行は進む", () => {
    const { arefine, home } = setup();
    const finished = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(home, "run.lock"), `${finished.pid}\n`);

    const first = arefine("collect");
    const second = arefine("collect");

    expect(first.stdout).toContain("0 件のセッションログから 0 件の発話を取り出しました。");
    expect(second.stdout).toContain("0 件のセッションログから 0 件の発話を取り出しました。");
  });
});
