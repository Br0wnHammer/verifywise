// Servers/services/intakeScoring/scoreMath.ts
// Rule-floored score maths. Keep identical to
// Clients/src/application/utils/intakeScoring/scoreMath.ts.

export type ClassificationLevel =
  "Prohibited" | "High risk" | "Limited risk" | "Minimal risk" | "Out of scope";
export type ScoreBand = "Low" | "Medium" | "High" | "Critical";
export type ScoreSource = "rule_minimum" | "ai";

export const RULE_MINIMUMS: Record<ClassificationLevel, number> = {
  Prohibited: 90,
  "High risk": 70,
  "Limited risk": 30,
  "Minimal risk": 0,
  "Out of scope": 0,
};

export const SCORE_BANDS: ReadonlyArray<{ band: ScoreBand; min: number; max: number }> = [
  { band: "Low", min: 0, max: 25 },
  { band: "Medium", min: 26, max: 50 },
  { band: "High", min: 51, max: 75 },
  { band: "Critical", min: 76, max: 100 },
];

export function ruleMinimumFor(level: ClassificationLevel | null): number | null {
  return level === null ? null : RULE_MINIMUMS[level];
}

export function bandFor(score: number): ScoreBand {
  const found = SCORE_BANDS.find((b) => score <= b.max);
  return found ? found.band : "Critical";
}

// Even length: rounded mean of the two middle values.
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function combineScore(input: { ruleMinimum: number | null; aiMedian: number | null }): {
  finalScore: number | null;
  source: ScoreSource | null;
  rulesOnly: boolean;
} {
  const { ruleMinimum, aiMedian } = input;
  if (aiMedian === null) {
    if (ruleMinimum === null || ruleMinimum === 0) {
      return { finalScore: null, source: null, rulesOnly: false };
    }
    return { finalScore: ruleMinimum, source: "rule_minimum", rulesOnly: true };
  }
  if (ruleMinimum === null) return { finalScore: aiMedian, source: "ai", rulesOnly: false };
  // A tie goes to the rule minimum.
  return aiMedian > ruleMinimum
    ? { finalScore: aiMedian, source: "ai", rulesOnly: false }
    : { finalScore: ruleMinimum, source: "rule_minimum", rulesOnly: false };
}

export function lowestAllowedBand(ruleMinimum: number | null): ScoreBand {
  return bandFor(ruleMinimum ?? 0);
}

export function isBandAllowed(band: ScoreBand, ruleMinimum: number | null): boolean {
  const order = SCORE_BANDS.map((b) => b.band);
  return order.indexOf(band) >= order.indexOf(lowestAllowedBand(ruleMinimum));
}
