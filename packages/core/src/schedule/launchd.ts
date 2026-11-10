import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Schedule, ScheduleTime } from "../config/config.ts";

export const LABEL = "com.github.sena-m09.arefine.run";
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ENV_KEYS = ["PATH", "AREFINE_HOME", "CLAUDE_CONFIG_DIR"];
const NOTIFY_ON_FAILURE = `echo "=== $(date '+%Y-%m-%d %H:%M:%S') arefine run ==="
"$0" "$1" run --scheduled
status=$?
if [ "$status" -ne 0 ]; then
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "aRefine"' -e 'end run' "定期実行が失敗しました。ログ: $2"
fi
exit "$status"`;

export type ScheduleFiles = {
  plist: string;
  log: string;
};

export function scheduleFiles(env: NodeJS.ProcessEnv, home: string): ScheduleFiles {
  return {
    plist: join(env["HOME"] ?? homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    log: join(home, "logs", "run.log"),
  };
}

export function writePlist(env: NodeJS.ProcessEnv, home: string, schedule: Schedule, time: ScheduleTime): ScheduleFiles {
  const files = scheduleFiles(env, home);
  mkdirSync(dirname(files.plist), { recursive: true });
  mkdirSync(dirname(files.log), { recursive: true });
  writeFileSync(files.plist, plist(env, home, schedule, time, files.log));
  return files;
}

function plist(env: NodeJS.ProcessEnv, home: string, schedule: Schedule, time: ScheduleTime, log: string): string {
  const environment = ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined ? [] : [`    <key>${key}</key>\n    <string>${escape(value)}</string>`];
  });
  const calendar = [...(schedule === "weekly" ? [["Weekday", 1]] : []), ["Hour", time.hour], ["Minute", time.minute]].map(
    ([key, value]) => `    <key>${key}</key>\n    <integer>${value}</integer>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${["/bin/sh", "-c", NOTIFY_ON_FAILURE, process.execPath, CLI, log].map((arg) => `    <string>${escape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment.join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>${escape(home)}</string>
  <key>StartCalendarInterval</key>
  <dict>
${calendar.join("\n")}
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(log)}</string>
</dict>
</plist>
`;
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
