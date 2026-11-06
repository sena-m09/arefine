import { z } from "zod";
import type { Llm, LlmResult } from "../llm/claude.ts";
import type { Budget } from "./budget.ts";
import type { Registry } from "./registry.ts";

const SYSTEM = `あなたは、人間が AI に出した修正指示（observation）を、中身が同じ指示ごとに「まとまり」に振り分けます。

入力には、既存のまとまりの一覧（空のこともあります）と、振り分ける observation の一覧が入っています。
- 既存のまとまり：id、指示の中身の1文、これまでに入った observation の件数
- observation：key と、指示の中身の1文（summary）

振り分け方：
- 言い回しが違っても、求めている行動が同じなら同じまとまりに入れます。
- 関連はしていても、求めている行動が違うなら別のまとまりにします。
- 既存のまとまりに合うものがあれば、そこに入れます。なければ新しいまとまりを作ります。
- 新しいまとまりには、その場で仮の key（n1, n2, …）を付け、指示の中身を「〜する」「〜しない」の形の1文で書きます。同じ新しい指示に当たる observation が複数あれば、同じ仮の key に入れます。
- observation はすべて、ちょうど1つのまとまりに入れます。

出力：
- new_groups：今回新しく作るまとまり（key と summary）
- assignments：observation ごとに、入れるまとまり（既存の id か、新しいまとまりの仮の key）`;

export const GroupingOutput = z.object({
  new_groups: z.array(z.object({ key: z.string().min(1), summary: z.string().min(1) })),
  assignments: z.array(z.object({ observation: z.string(), group: z.string() })),
});
export type GroupingOutput = z.infer<typeof GroupingOutput>;

export type GroupingResult =
  | { ok: true; output: GroupingOutput; costUsd: number }
  | { ok: false; error: string; costUsd: number };

export function requestGrouping(
  llm: Llm,
  budget: Budget,
  registry: Registry,
  observations: { key: string; summary: string }[],
): GroupingResult {
  const result: LlmResult = llm({
    system: SYSTEM,
    prompt: [
      "既存のまとまり:",
      ...(registry.groups.length === 0
        ? ["（なし）"]
        : registry.groups.map((group) =>
            JSON.stringify({ id: group.id, summary: group.summary, count: group.observation_ids.length }),
          )),
      "",
      "振り分ける observation:",
      ...observations.map(({ key, summary }) => JSON.stringify({ key, summary })),
    ].join("\n"),
    schema: z.toJSONSchema(GroupingOutput),
    maxBudgetUsd: budget.limitUsd,
  });
  budget.charge(result.costUsd);
  if (!result.ok) {
    return result;
  }
  const output = GroupingOutput.safeParse(result.output);
  return output.success
    ? { ok: true, output: output.data, costUsd: result.costUsd }
    : { ok: false, error: "指示のまとまりへの振り分けが想定した形式ではありません", costUsd: result.costUsd };
}
