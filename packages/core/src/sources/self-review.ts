import { createHash } from "node:crypto";
import { z } from "zod";
import { Evidence, GuidanceId } from "../pipeline/observation.ts";
import type { Observation } from "../pipeline/observation.ts";

export const SelfReview = z.object({
  cwd: z.string().min(1).optional(),
  session: z.string().min(1),
  findings: z.array(
    z.object({
      guidance_id: GuidanceId.nullable().default(null),
      summary: z.string().min(1),
      evidence: Evidence.extend({ fix: Evidence.shape.fix.default(null) }).optional(),
    }),
  ),
});
export type SelfReview = z.infer<typeof SelfReview>;

export function selfReviewObservations(review: SelfReview, repo: string, cwd: string, at: Date): Observation[] {
  const observations = review.findings.map(
    (finding): Observation => ({
      id: `obs_review_${digest([repo, review.session, finding.guidance_id, finding.summary, finding.evidence?.violation])}`,
      at: at.toISOString(),
      source: "self-review",
      repo,
      cwd,
      guidance_id: finding.guidance_id,
      summary: finding.summary,
      stated_as_rule: false,
      risk_kind: null,
      ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
      ref: { candidate: null, session: review.session, log: null },
    }),
  );
  return [...new Map(observations.map((observation) => [observation.id, observation])).values()];
}

function digest(parts: (string | null | undefined)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? null)))
    .digest("hex")
    .slice(0, 16);
}
