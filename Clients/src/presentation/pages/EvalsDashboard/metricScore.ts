// One metric's entry in an evaluation log's metadata.metric_scores.
// Older logs store a bare number; current ones store an object.
export type MetricScoreEntry =
  | number
  | {
      score?: number | null;
      passed?: boolean;
      threshold?: number | null;
    }
  | null
  | undefined;

// Metrics where a lower score is better (green = low, red = high)
export const lowerIsBetter = (metricName: string): boolean => {
  const n = metricName.toLowerCase();
  return n.includes("bias") || n.includes("toxicity") || n.includes("hallucination");
};

export const entryScore = (entry: MetricScoreEntry): number | null => {
  if (typeof entry === "number") return entry;
  return typeof entry?.score === "number" ? entry.score : null;
};

// Skipped and errored metrics have no score and are left out of pass counts.
export const isScored = (entry: MetricScoreEntry): boolean => entryScore(entry) !== null;

// The backend's passed flag already means "good" for every metric, lower is better
// ones included. Without it, compare the score with the stored threshold (0.5 when
// there is none) in the metric's own direction.
export const metricPassed = (metricName: string, entry: MetricScoreEntry): boolean => {
  if (typeof entry === "object" && typeof entry?.passed === "boolean") return entry.passed;
  const score = entryScore(entry);
  if (score === null) return false;
  const threshold =
    typeof entry === "object" && typeof entry?.threshold === "number" ? entry.threshold : 0.5;
  return lowerIsBetter(metricName) ? score <= threshold : score >= threshold;
};
