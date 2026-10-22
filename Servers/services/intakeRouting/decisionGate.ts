import { randomInt as cryptoRandomInt } from "crypto";
import { bandFor, type ScoreBand } from "../intakeScoring/scoreMath";
import type { IFormRouting } from "../../domain.layer/interfaces/i.intakeForm";
import type {
  IDecisionRecord,
  IRiskAssessmentV2,
  ISubmissionRouting,
  ReviewLane,
  RoutingReason,
} from "../../domain.layer/interfaces/i.intakeSubmission";
import { BAND_LOWER_BOUND, laneFor } from "./routingRules";

/**
 * The lane a decision is made in: the stored lane, raised to senior when the
 * values the decision would make true (level and score after a reviewer's
 * overrides, the band in force as a floor on the score) route there. Never
 * lowers a lane. Null when routing is off or the submission has no lane yet.
 */
export function laneAtDecision(
  stored: ISubmissionRouting | null,
  cfg: IFormRouting | null,
  effective: {
    level: string | null;
    finalScore: number | null;
    scoringStatus: string | null;
    bandInForce: ScoreBand | null;
  },
): { lane: ReviewLane | null; reason: RoutingReason | null } {
  if (!cfg?.enabled || !stored) return { lane: null, reason: null };
  if (stored.lane === "senior") return { lane: "senior", reason: stored.reason };

  const bandFloor = effective.bandInForce ? BAND_LOWER_BOUND[effective.bandInForce] : null;
  const finalScore =
    effective.finalScore !== null && bandFloor !== null
      ? Math.max(effective.finalScore, bandFloor)
      : effective.finalScore;
  const result = laneFor(
    { level: effective.level, finalScore, scoringStatus: effective.scoringStatus },
    cfg,
  );
  return result.lane === "senior" ? result : { lane: "standard", reason: stored.reason };
}

/** Computed vs. in-force band as they stand when the decision is made. */
export function buildDecisionRecord(args: {
  level: string | null;
  assessment: IRiskAssessmentV2 | null;
  override: { tier: string; overriddenBy: number } | null;
  lane: ReviewLane | null;
}): IDecisionRecord {
  const finalScore = args.assessment?.finalScore ?? null;
  const computedBand = finalScore === null ? null : bandFor(finalScore);
  const bandInForce = args.override?.tier ?? computedBand;
  return {
    level: args.level,
    computedBand,
    bandInForce,
    bandChanged: bandInForce !== computedBand,
    overriddenBy: args.override?.overriddenBy ?? null,
    lane: args.lane,
  };
}

/** True with probability `rate` percent. */
export function pickSecondReview(
  rate: number,
  randomInt: (max: number) => number = (max) => cryptoRandomInt(max),
): boolean {
  return randomInt(100) < rate;
}
