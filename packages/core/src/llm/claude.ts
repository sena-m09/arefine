import { spawnSync } from "node:child_process";
import { z } from "zod";
import { parseJson } from "../pipeline/jsonl.ts";

export type LlmRequest = {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxBudgetUsd: number;
  cwd?: string;
  tools?: string[];
};

export type LlmResult = { ok: true; output: unknown; costUsd: number } | { ok: false; error: string; costUsd: number };

export type Llm = (request: LlmRequest) => LlmResult;

export const MODEL = "sonnet";

const Envelope = z.object({
  is_error: z.boolean(),
  subtype: z.string(),
  total_cost_usd: z.number(),
  structured_output: z.unknown().optional(),
  errors: z.array(z.string()).optional(),
});

export const claudeLlm: Llm = (request) => {
  const tools = request.tools ?? [];
  // claude の --json-schema は $schema（draft 2020-12）があると受け付けない
  const { $schema: _draft, ...schema } = request.schema;
  const child = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      MODEL,
      "--output-format",
      "json",
      // 保存すると、次の collect がこの呼び出しを人間の発話として拾ってしまう
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--system-prompt",
      request.system,
      "--json-schema",
      JSON.stringify(schema),
      "--max-budget-usd",
      String(request.maxBudgetUsd),
      "--tools",
      tools.join(","),
      ...(tools.length > 0 ? ["--allowedTools", ...tools] : []),
    ],
    {
      input: request.prompt,
      cwd: request.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    },
  );
  if (child.error) {
    return { ok: false, error: `claude を実行できません: ${child.error.message}`, costUsd: 0 };
  }
  const envelope = Envelope.safeParse(parseJson(child.stdout));
  if (!envelope.success) {
    return { ok: false, error: `claude の出力を読めません: ${child.stderr.trim() || child.stdout.slice(0, 200)}`, costUsd: 0 };
  }
  const { is_error, subtype, total_cost_usd, structured_output, errors } = envelope.data;
  if (is_error || structured_output === undefined) {
    return { ok: false, error: `claude が失敗しました（${subtype}）: ${(errors ?? []).join(" ")}`, costUsd: total_cost_usd };
  }
  return { ok: true, output: structured_output, costUsd: total_cost_usd };
};
