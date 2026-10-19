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
    }
  | null
  | undefined;

// Metrics where a lower score is better (green = low, red = high)
export const lowerIsBetter = (metricName: string): boolean => {
  const n = metricName.toLowerCase();
  return n.includes("bias") || n.includes("toxicity") || n.includes("hallucination");
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

// A metric skipped for missing input (e.g. no retrieval context) was never evaluated.
// An errored metric was attempted and counts as failed.
export const isSkipped = (entry: MetricScoreEntry): boolean =>
  typeof entry === "object" && entry?.skipped === true;

// The backend's passed flag already means "good" for every metric, lower is better
// ones included. Without it, a higher is better metric is compared with its stored
// threshold. Lower is better ones use 0.5: for G-Eval judges their stored threshold
// applies to the score before it was inverted.
export const metricPassed = (metricName: string, entry: MetricScoreEntry): boolean => {
  if (typeof entry === "object" && typeof entry?.passed === "boolean") return entry.passed;
  const score = entryScore(entry);
  if (score === null) return false;
  if (lowerIsBetter(metricName)) return score <= 0.5;
  const threshold =
    typeof entry === "object" && typeof entry?.threshold === "number" ? entry.threshold : 0.5;
  return score >= threshold;
};
