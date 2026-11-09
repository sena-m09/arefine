import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GroupedProposal, RegistryStats } from "./registry.ts";
import { recordReport } from "./unread.ts";

export type ReportSection = {
  refiner: string;
  proposals: GroupedProposal[];
  stats: RegistryStats | null;
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
      `根拠: ${evidence(proposal)}`,
      "",
      proposal.change.trim(),
      "",
    ]),
    ...(section.stats === null || section.stats.judged === 0 ? [] : [statsLine(section.stats), ""]),
  ]);
  appendFileSync(file, `${[...header, ...body].join("\n")}\n`);
  recordReport(dir, {
    at: now.toISOString(),
    report: file,
    proposals: filled.reduce((sum, section) => sum + section.proposals.length, 0),
  });
  return file;
}

function evidence(proposal: GroupedProposal): string {
  if (proposal.groups.length === 0) {
    return "なし";
  }
  return proposal.groups
    .map((group) => `${group.id}（${group.observation_ids.map((id) => `\`${id}\``).join(", ")}）`)
    .join("、");
}

function statsLine(stats: RegistryStats): string {
  const adopted =
    stats.trackable === 0
      ? ""
      : `取り入れたかを確かめる提案 ${stats.trackable} 件のうち、取り入れ済みは ${stats.resolved} 件（${Math.round((stats.resolved / stats.trackable) * 100)}%）です。`;
  return `これまでに判定した指示のまとまりは ${stats.judged} 件です。${adopted}`;
}
