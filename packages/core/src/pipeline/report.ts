import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Proposal } from "./dispatch.ts";

export type ReportSection = {
  refiner: string;
  proposals: Proposal[];
};

export function writeReport(dir: string, repo: string, sections: ReportSection[], now: Date): string | null {
  const filled = sections.filter((section) => section.proposals.length > 0);
  if (filled.length === 0) {
    return null;
  }
  const date = now.toLocaleDateString("sv-SE");
  const time = now.toTimeString().slice(0, 5);
  const reportsDir = join(dir, "reports");
  const file = join(reportsDir, `${date}.md`);
  mkdirSync(reportsDir, { recursive: true });

  const header = existsSync(file) ? [] : [`# ${repo} の改善提案（${date}）`, ""];
  const body = filled.flatMap((section) => [
    `## ${section.refiner}（${time} の実行）`,
    "",
    ...section.proposals.flatMap((proposal) => [
      `### ${proposal.title}`,
      "",
      `根拠: ${proposal.observation_ids.length > 0 ? proposal.observation_ids.map((id) => `\`${id}\``).join(", ") : "なし"}`,
      "",
      proposal.change.trim(),
      "",
    ]),
  ]);
  appendFileSync(file, `${[...header, ...body].join("\n")}\n`);
  return file;
}
