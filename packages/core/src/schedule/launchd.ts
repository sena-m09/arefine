import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Schedule } from "../config/config.ts";

export const LABEL = "com.github.sena-m09.arefine.run";
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ENV_KEYS = ["PATH", "AREFINE_HOME", "CLAUDE_CONFIG_DIR"];

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

export function writePlist(env: NodeJS.ProcessEnv, home: string, schedule: Schedule): ScheduleFiles {
  const files = scheduleFiles(env, home);
  mkdirSync(dirname(files.plist), { recursive: true });
  mkdirSync(dirname(files.log), { recursive: true });
  writeFileSync(files.plist, plist(env, home, schedule, files.log));
  return files;
}

function plist(env: NodeJS.ProcessEnv, home: string, schedule: Schedule, log: string): string {
  const environment = ENV_KEYS.flatMap((key) => {
    const value = env[key];
    return value === undefined ? [] : [`    <key>${key}</key>\n    <string>${escape(value)}</string>`];
  });
  const calendar = [...(schedule === "weekly" ? [["Weekday", 1]] : []), ["Hour", 3], ["Minute", 0]].map(
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
    <string>${escape(process.execPath)}</string>
    <string>${escape(CLI)}</string>
    <string>run</string>
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
