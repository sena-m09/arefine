import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const readPlist = () => readFileSync(plist, "utf8");
  const notified = join(root, "notified");
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "osascript"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${notified}"\n`);
  chmodSync(join(fakeBin, "osascript"), 0o755);
  return {
    home,
    plist,
    arefine: (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env }),
    readPlist,
    programArguments: () => programArguments(readPlist()),
    launch: (args: string[]) => {
      const [program = "", ...rest] = args;
      return spawnSync(program, rest, { encoding: "utf8", env: { ...env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` } });
    },
    notification: () => (existsSync(notified) ? readFileSync(notified, "utf8") : null),
  };
}

function programArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(([, value = ""]) =>
    value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  );
}

describe("arefine schedule", () => {
  test("毎日 3:00 に run する plist を LaunchAgents に置き、登録と解除のコマンドを表示する", () => {
    const { arefine, plist, readPlist } = setup();

    const result = arefine("schedule");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("頻度: 毎日 3:00");
    expect(result.stdout).toContain(`launchctl bootstrap gui/$(id -u) "${plist}"`);
    expect(result.stdout).toContain("launchctl bootout gui/$(id -u)/com.github.sena-m09.arefine.run");
    expect(readPlist()).toMatch(
      /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>3<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/,
    );
  });

  test("config.yaml で schedule: weekly にすると、週に1回だけ動く", () => {
    const { arefine, readPlist } = setup("schedule: weekly\n");

    arefine("schedule");

    expect(readPlist()).toMatch(/<key>Weekday<\/key>\s*<integer>1<\/integer>/);
  });

  test("config.yaml の schedule_time に引用符なしで 08:30 と書くと、8:30 に動く", () => {
    const { arefine, readPlist } = setup("schedule: weekly\nschedule_time: 08:30\n");

    const result = arefine("schedule");

    expect(result.stdout).toContain("頻度: 毎週月曜 8:30");
    expect(readPlist()).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  });

  test("schedule_time が 0:00〜23:59 の時刻でなければ、どの項目かを示して止め、plist を書かない", () => {
    const { arefine, plist } = setup('schedule_time: "24:00"\n');

    const result = arefine("schedule");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('schedule_time: "08:30" のように 0:00〜23:59 の時刻で書いてください（いまの値: 24:00）');
    expect(() => readFileSync(plist)).toThrow();
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

describe("定期実行が失敗したときの通知", () => {
  test("Node が見つからないなど run が失敗したら、ログのパスを入れて通知し、失敗の終了コードを launchd に返す", () => {
    const { arefine, home, programArguments, launch, notification } = setup("refiners:\n  lint:\n    enabled: true\n");
    arefine("schedule");
    const [sh = "", flag = "", script = "", , ...rest] = programArguments();

    const result = launch([sh, flag, script, "/nonexistent/node", ...rest]);

    expect(result.status).not.toBe(0);
    expect(notification()).toContain(`定期実行が失敗しました。ログ: ${join(home, "logs", "run.log")}`);
  });

  test("有効な観点がないまま定期実行が動いたら、失敗として通知する", () => {
    const { arefine, programArguments, launch, notification } = setup();
    arefine("schedule");

    const result = launch(programArguments());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("定期実行で何もできなかったため、失敗として終わります。");
    expect(notification()).toContain("定期実行が失敗しました。");
  });

  test("手で run したときは、有効な観点がなくても正常終了する", () => {
    const { arefine } = setup();

    const result = arefine("run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("有効な観点がないため、ここで止めました。");
  });

  test("別の arefine が動いていて飛ばしたときは、通知しない", () => {
    const { arefine, home, programArguments, launch, notification } = setup();
    arefine("schedule");
    writeFileSync(join(home, "run.lock"), `${process.pid}\n`);

    const result = launch(programArguments());

    expect(result.status).toBe(0);
    expect(notification()).toBeNull();
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
