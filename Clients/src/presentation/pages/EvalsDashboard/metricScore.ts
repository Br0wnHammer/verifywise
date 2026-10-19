import { palette } from "../../themes/palette";

// One metric's entry in an evaluation log's metadata.metric_scores.
// Older logs store a bare number; current ones store an object.
export type MetricScoreEntry =
  | number
  | {
      score?: number | null;
      passed?: boolean;
      threshold?: number | null;
      skipped?: boolean;
      error?: string;
      reason?: string;
    }
  | null
  | undefined;

// Metrics where a lower score is better (0 = none found; green = low, red = high).
// Matched by exact name, so a custom scorer such as "unbiasedTone" is not inverted.
// Keep in sync with EvalServer/src/utils/metric_constants.py.
const LOWER_IS_BETTER_METRICS = new Set(["bias", "toxicity", "hallucination"]);

export const lowerIsBetter = (metricName: string): boolean => {
  const name = metricName.replace(/^G-Eval\s*\((.+)\)$/i, "$1");
  return LOWER_IS_BETTER_METRICS.has(name.toLowerCase().replace(/[\s_]/g, ""));
};

// Finds a metric's entry by exact name, "G-Eval (<name>)", or either form ignoring case.
export const findMetricEntry = (
  scores: Record<string, MetricScoreEntry> | undefined,
  metricName: string,
): MetricScoreEntry => {
  if (!scores) return undefined;
  if (scores[metricName] !== undefined) return scores[metricName];
  const gevalKey = `G-Eval (${metricName})`;
  if (scores[gevalKey] !== undefined) return scores[gevalKey];
  const wanted = metricName.toLowerCase();
  const key = Object.keys(scores).find(
    (k) =>
      k.toLowerCase() === wanted ||
      k.replace(/^G-Eval\s*\((.+)\)$/i, "$1").toLowerCase() === wanted,
  );
  return key ? scores[key] : undefined;
};

export const entryScore = (entry: MetricScoreEntry): number | null => {
  if (typeof entry === "number") return entry;
  return typeof entry?.score === "number" ? entry.score : null;
};

// The evaluator's error message, or null when the metric did not error.
export const entryError = (entry: MetricScoreEntry): string | null =>
  typeof entry === "object" && typeof entry?.error === "string" ? entry.error : null;

export const entryReason = (entry: MetricScoreEntry): string | undefined =>
  typeof entry === "object" && typeof entry?.reason === "string" ? entry.reason : undefined;

// For a scored entry. The backend's passed flag already means "good" for every metric,
// lower is better ones included. Without it, a higher is better metric is compared with
// its stored threshold. Lower is better ones use 0.5: for G-Eval judges their stored
// threshold applies to the score before it was inverted.
const scoredMetricPassed = (metricName: string, entry: MetricScoreEntry, score: number) => {
  if (typeof entry === "object" && typeof entry?.passed === "boolean") return entry.passed;
  if (lowerIsBetter(metricName)) return score <= 0.5;
  const threshold =
    typeof entry === "object" && typeof entry?.threshold === "number" ? entry.threshold : 0.5;
  return score >= threshold;
};

export type MetricStatus = "passed" | "failed" | "notEvaluated";

// One rule for every view:
// - an error, or an explicit passed: false without a score (e.g. an unparseable judge
//   reply), is a failure;
// - a missing or skipped metric (e.g. no retrieval context), or one with no score and
//   no failure recorded, was not evaluated and is left out of pass counts;
// - otherwise the score decides.
export const metricStatus = (metricName: string, entry: MetricScoreEntry): MetricStatus => {
  if (entry == null) return "notEvaluated";
  if (entryError(entry) !== null) return "failed";
  if (typeof entry === "object" && entry.skipped === true) return "notEvaluated";
  const score = entryScore(entry);
  if (score === null) {
    return typeof entry === "object" && entry.passed === false ? "failed" : "notEvaluated";
  }
  return scoredMetricPassed(metricName, entry, score) ? "passed" : "failed";
};

export const METRIC_STATUS_COLORS: Record<MetricStatus, { bg: string; text: string }> = {
  passed: { bg: palette.status.success.bg, text: palette.status.success.text },
  failed: { bg: palette.status.error.bg, text: palette.status.error.text },
  notEvaluated: { bg: "transparent", text: palette.status.default.text },
};
