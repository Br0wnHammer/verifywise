import { describe, expect, it } from "vitest";
import { entryError, findMetricEntry, lowerIsBetter, metricStatus } from "../metricScore";

describe("lowerIsBetter", () => {
  it("covers bias, toxicity and hallucination in any naming", () => {
    expect(lowerIsBetter("Bias")).toBe(true);
    expect(lowerIsBetter("toxicity")).toBe(true);
    expect(lowerIsBetter("G-Eval (Hallucination)")).toBe(true);
    expect(lowerIsBetter("Correctness")).toBe(false);
    expect(lowerIsBetter("Conversation Safety")).toBe(false);
  });

  it("does not invert a metric whose name only contains one of those words", () => {
    expect(lowerIsBetter("unbiasedTone")).toBe(false);
    expect(lowerIsBetter("Hallucination Resistance")).toBe(false);
    expect(lowerIsBetter("G-Eval (Toxicity-free tone)")).toBe(false);
  });
});

describe("metricStatus", () => {
  it("trusts the backend flag for lower is better metrics", () => {
    // A clean answer: no bias found, and the evaluator marked it passed.
    expect(metricStatus("Bias", { score: 0, passed: true })).toBe("passed");
    expect(metricStatus("Hallucination", { score: 0.9, passed: false })).toBe("failed");
  });

  it("trusts the backend flag for higher is better metrics", () => {
    expect(metricStatus("Correctness", { score: 1, passed: true })).toBe("passed");
    expect(metricStatus("Correctness", { score: 0.2, passed: false })).toBe("failed");
  });

  it("falls back to the stored threshold for higher is better metrics", () => {
    expect(metricStatus("Correctness", { score: 0.6, threshold: 0.8 })).toBe("failed");
    expect(metricStatus("Correctness", { score: 0.85, threshold: 0.8 })).toBe("passed");
  });

  it("falls back to 0.5 for lower is better metrics, whatever the stored threshold", () => {
    // G-Eval stores 1 - score but keeps the threshold for the raw score.
    expect(metricStatus("Hallucination", { score: 0.6, threshold: 0.7 })).toBe("failed");
    expect(metricStatus("Hallucination", { score: 0.2, threshold: 0.7 })).toBe("passed");
  });

  it("falls back to 0.5 for bare numbers", () => {
    expect(metricStatus("Toxicity", 0.4)).toBe("passed");
    expect(metricStatus("Toxicity", 0.6)).toBe("failed");
    expect(metricStatus("Relevance", 0.5)).toBe("passed");
  });

  it("fails an errored metric, even with an empty message or a skipped flag", () => {
    expect(metricStatus("Toxicity", { score: null, passed: false, error: "timeout" })).toBe(
      "failed",
    );
    expect(metricStatus("Toxicity", { score: null, passed: false, error: "" })).toBe("failed");
    expect(metricStatus("Toxicity", { score: null, skipped: true, error: "boom" })).toBe("failed");
  });

  it("fails an unscored metric the backend marked as failed", () => {
    // The evaluator writes this when the judge's reply could not be parsed.
    expect(metricStatus("Correctness", { score: null, passed: false })).toBe("failed");
  });

  it("does not evaluate skipped, missing or unscored metrics", () => {
    expect(metricStatus("Faithfulness", { score: null, passed: false, skipped: true })).toBe(
      "notEvaluated",
    );
    expect(metricStatus("Faithfulness", undefined)).toBe("notEvaluated");
    expect(metricStatus("Faithfulness", null)).toBe("notEvaluated");
    expect(metricStatus("Faithfulness", { score: null })).toBe("notEvaluated");
    // A passed flag without a score does not claim a pass.
    expect(metricStatus("Bias", { score: null, passed: true })).toBe("notEvaluated");
  });
});

describe("entryError", () => {
  it("returns the error message only when one is set", () => {
    expect(entryError({ score: null, error: "Judge timeout" })).toBe("Judge timeout");
    expect(entryError({ score: 0.5 })).toBeNull();
    expect(entryError(0.5)).toBeNull();
  });
});

describe("findMetricEntry", () => {
  const scores = {
    "Bias": { score: 0, passed: true },
    "G-Eval (Correctness)": { score: 0.9, passed: true },
    "hallucination": 0.1,
  };

  it("matches the exact name, the G-Eval form, and either ignoring case", () => {
    expect(findMetricEntry(scores, "Bias")).toEqual({ score: 0, passed: true });
    expect(findMetricEntry(scores, "Correctness")).toEqual({ score: 0.9, passed: true });
    expect(findMetricEntry(scores, "correctness")).toEqual({ score: 0.9, passed: true });
    expect(findMetricEntry(scores, "Hallucination")).toBe(0.1);
  });

  it("returns undefined when there is no entry", () => {
    expect(findMetricEntry(scores, "Toxicity")).toBeUndefined();
    expect(findMetricEntry(undefined, "Bias")).toBeUndefined();
  });
});
