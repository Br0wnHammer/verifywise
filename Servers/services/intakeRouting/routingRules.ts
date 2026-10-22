import type { ScoreBand } from "../intakeScoring/scoreMath";
import type { IFormRouting } from "../../domain.layer/interfaces/i.intakeForm";
import type { ReviewLane, RoutingReason } from "../../domain.layer/interfaces/i.intakeSubmission";

export const DEFAULT_ROUTING: Omit<
  IFormRouting,
  "enabled" | "seniorReviewerIds" | "standardReviewerIds"
> = { threshold: 50, closeCallMargin: 10, secondReviewRate: 10 };

/** Lowest score of each band, used to re-route after a band override. */
export const BAND_LOWER_BOUND: Record<ScoreBand, number> = {
  Low: 0,
  Medium: 26,
  High: 51,
  Critical: 76,
};

/** First matching rule wins. */
export function laneFor(
  input: { level: string | null; finalScore: number | null; scoringStatus: string | null },
  cfg: Pick<IFormRouting, "threshold" | "closeCallMargin">,
): { lane: ReviewLane; reason: RoutingReason } {
  if (input.level === "Prohibited") return { lane: "senior", reason: "prohibited" };
  if (input.finalScore === null || input.scoringStatus === "ai_failed") {
    return { lane: "senior", reason: "no_score" };
  }
  if (Math.abs(input.finalScore - cfg.threshold) < cfg.closeCallMargin) {
    return { lane: "senior", reason: "close_call" };
  }
  if (input.finalScore >= cfg.threshold) {
    return { lane: "senior", reason: "at_or_above_threshold" };
  }
  return { lane: "standard", reason: "below_threshold" };
}

const RANGES = {
  threshold: { min: 1, max: 99 },
  closeCallMargin: { min: 0, max: 25 },
  secondReviewRate: { min: 0, max: 100 },
} as const;

function parseIds(raw: unknown, name: string): number[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return `${name} must be an array`;
  const ids: number[] = [];
  for (const v of raw) {
    if (!Number.isSafeInteger(v) || (v as number) <= 0) {
      return `${name} must contain positive integer user ids`;
    }
    if (!ids.includes(v as number)) ids.push(v as number);
  }
  return ids;
}

export function validateRoutingSettings(
  raw: unknown,
): { ok: true; value: IFormRouting } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "routing must be an object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }

  const senior = parseIds(body.seniorReviewerIds, "seniorReviewerIds");
  if (typeof senior === "string") return { ok: false, error: senior };
  const standard = parseIds(body.standardReviewerIds, "standardReviewerIds");
  if (typeof standard === "string") return { ok: false, error: standard };

  const numbers = {} as Record<keyof typeof RANGES, number>;
  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const value = body[key] === undefined ? DEFAULT_ROUTING[key] : body[key];
    const { min, max } = RANGES[key];
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      return { ok: false, error: `${key} must be a whole number from ${min} to ${max}` };
    }
    numbers[key] = value as number;
  }

  if (body.enabled && (senior.length === 0 || standard.length === 0)) {
    return {
      ok: false,
      error: "seniorReviewerIds and standardReviewerIds must each have at least one reviewer",
    };
  }

  return {
    ok: true,
    value: {
      enabled: body.enabled,
      seniorReviewerIds: senior,
      standardReviewerIds: standard,
      ...numbers,
    },
  };
}

export function canDecideLane(
  lane: ReviewLane | null,
  userId: number,
  isAdmin: boolean,
  cfg: IFormRouting | null,
): boolean {
  if (!cfg?.enabled || lane === null || isAdmin) return true;
  if (cfg.seniorReviewerIds.includes(userId)) return true;
  return lane === "standard" && cfg.standardReviewerIds.includes(userId);
}

/** Ids of the users who can decide a submission in a lane: senior reviewers sit in both. */
export function laneReviewerIdsFor(lane: ReviewLane | null, cfg: IFormRouting | null): number[] {
  if (!cfg?.enabled || lane === null) return [];
  if (lane === "senior") return cfg.seniorReviewerIds;
  return [...new Set([...cfg.standardReviewerIds, ...cfg.seniorReviewerIds])];
}
