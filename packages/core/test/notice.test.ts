import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { repoFromRemoteUrl as hookRepoFromRemoteUrl } from "../../../plugin/claude-code/hooks/unread.ts";
import { repoFromRemoteUrl } from "../src/pipeline/repo.ts";
import { writeReport } from "../src/pipeline/report.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hook = fileURLToPath(new URL("../../../plugin/claude-code/hooks/session-start.ts", import.meta.url));

const HookOutput = z.object({
  systemMessage: z.string(),
  hookSpecificOutput: z.object({ hookEventName: z.literal("SessionStart"), additionalContext: z.string() }),
});

const RemoteUrls = z.array(z.object({ url: z.string(), repo: z.string().nullable() }));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "arefine-notice-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repo = join(root, "widget");
  const plain = join(root, "plain");
  mkdirSync(plain);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  const env = { ...process.env, AREFINE_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude") };
  const dir = join(home, "acme__widget");

  return {
    repo,
    plain,
    reportPath: (date: string) => join(dir, "reports", `${date}.md`),
    writeReport: (at: string, proposals: number) =>
      writeReport(
        dir,
        "acme/widget",
        [
          {
            refiner: "lint",
            proposals: Array.from({ length: proposals }, (_, i) => ({ title: `提案 ${i + 1}`, change: "直す", groups: [] })),
            stats: null,
          },
        ],
        new Date(at),
      ),
    sessionStart: (cwd: string) => {
      const result = spawnSync(process.execPath, [hook], {
        encoding: "utf8",
        env,
        input: JSON.stringify({ session_id: "s-1", cwd, hook_event_name: "SessionStart", source: "startup" }),
      });
      expect(result.status).toBe(0);
      return result.stdout === "" ? null : HookOutput.parse(JSON.parse(result.stdout));
    },
    arefine: (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd }),
  };
}

describe("セッションの開始時に、まだ読んでいない提案を知らせる", () => {
  test("提案が出たリポジトリでセッションを始めると、利用者と Claude に件数とレポートのパスを知らせる", () => {
    const { repo, reportPath, writeReport, sessionStart } = setup();
    writeReport("2026-11-06T03:00:00.000Z", 2);

    const output = sessionStart(repo);

    expect(output?.systemMessage).toContain("acme/widget にまだ読んでいない提案が 2 件あります。");
    expect(output?.systemMessage).toContain(reportPath("2026-11-06"));
    expect(output?.systemMessage).toContain("arefine ack");
    expect(output?.hookSpecificOutput.additionalContext).toContain(reportPath("2026-11-06"));
  });

  test("複数の日のレポートにまたがるときは、件数を合わせ、新しいレポートから並べる", () => {
    const { repo, reportPath, writeReport, sessionStart } = setup();
    writeReport("2026-11-05T03:00:00.000Z", 1);
    writeReport("2026-11-06T03:00:00.000Z", 2);

    const message = sessionStart(repo)?.systemMessage ?? "";

    expect(message).toContain("提案が 3 件あります。");
    expect(message.indexOf(reportPath("2026-11-06"))).toBeLessThan(message.indexOf(reportPath("2026-11-05")));
  });

  test("arefine ack のあとは何も知らせず、同じ日のレポートに足された提案だけを次に知らせる", () => {
    const { repo, writeReport, sessionStart, arefine } = setup();
    writeReport("2026-11-06T03:00:00.000Z", 2);

    const acked = arefine(repo, "ack");
    expect(acked.status).toBe(0);
    expect(acked.stdout).toContain("acme/widget の提案 2 件を読んだことにしました。");
    expect(sessionStart(repo)).toBeNull();

    writeReport("2026-11-06T09:00:00.000Z", 1);
    expect(sessionStart(repo)?.systemMessage).toContain("提案が 1 件あります。");
  });

  test("ack より前に始まった run があとからレポートを書いても、その提案は読んでいないものとして残る", () => {
    const { repo, writeReport, sessionStart, arefine } = setup();
    writeReport("2026-11-06T03:00:00.000Z", 2);
    arefine(repo, "ack");

    writeReport("2026-11-06T03:30:00.000Z", 1);

    expect(sessionStart(repo)?.systemMessage).toContain("提案が 1 件あります。");
  });

  test.each([
    ["提案がまだ出ていないリポジトリ", "repo"],
    ["git のリポジトリでないフォルダ", "plain"],
    ["存在しないフォルダ", "missing"],
  ] as const)("%s では何も出さずに正常終了する", (_, where) => {
    const { repo, plain, sessionStart } = setup();
    const cwd = where === "repo" ? repo : where === "plain" ? plain : join(plain, "missing");

    expect(sessionStart(cwd)).toBeNull();
  });
});

describe("arefine ack", () => {
  test("読んでいない提案がなければ、そう伝えて正常終了する", () => {
    const { repo, arefine } = setup();

    const result = arefine(repo, "ack");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acme/widget にまだ読んでいない提案はありません。");
  });

  test("リポジトリが分からないフォルダでは --repo での指定を案内してエラー終了し、--repo を付ければ既読にできる", () => {
    const { plain, repo, writeReport, sessionStart, arefine } = setup();
    writeReport("2026-11-06T03:00:00.000Z", 1);

    const unknown = arefine(plain, "ack");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("--repo owner/name で指定してください。");

    const named = arefine(plain, "ack", "--repo", "acme/widget");
    expect(named.status).toBe(0);
    expect(sessionStart(repo)).toBeNull();
  });
});

describe("remote の URL からリポジトリ名を得る", () => {
  const cases = RemoteUrls.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/remote-urls.json", import.meta.url)), "utf8")),
  );

  test.each(cases)("collect とセッション開始の hook は、$url から同じ $repo を得る", ({ url, repo }) => {
    expect(repoFromRemoteUrl(url)).toBe(repo);
    expect(hookRepoFromRemoteUrl(url)).toBe(repo);
  });
});
