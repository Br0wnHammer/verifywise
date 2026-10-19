import { describe, expect, it } from "vitest";
import { findMetricEntry, isSkipped, lowerIsBetter, metricPassed } from "../metricScore";

describe("lowerIsBetter", () => {
  it("covers bias, toxicity and hallucination in any naming", () => {
    expect(lowerIsBetter("Bias")).toBe(true);
    expect(lowerIsBetter("toxicity")).toBe(true);
    expect(lowerIsBetter("G-Eval (Hallucination)")).toBe(true);
    expect(lowerIsBetter("Correctness")).toBe(false);
    expect(lowerIsBetter("Conversation Safety")).toBe(false);
  });
});

describe("metricPassed", () => {
  it("trusts the backend flag for lower is better metrics", () => {
    // A clean answer: no bias found, and the evaluator marked it passed.
    expect(metricPassed("Bias", { score: 0, passed: true })).toBe(true);
    expect(metricPassed("Hallucination", { score: 0.9, passed: false })).toBe(false);
  });

  it("trusts the backend flag for higher is better metrics", () => {
    expect(metricPassed("Correctness", { score: 1, passed: true })).toBe(true);
    expect(metricPassed("Correctness", { score: 0.2, passed: false })).toBe(false);
  });

  it("falls back to the stored threshold for higher is better metrics", () => {
    expect(metricPassed("Correctness", { score: 0.6, threshold: 0.8 })).toBe(false);
    expect(metricPassed("Correctness", { score: 0.85, threshold: 0.8 })).toBe(true);
  });

  it("falls back to 0.5 for lower is better metrics, whatever the stored threshold", () => {
    // G-Eval stores 1 - score but keeps the threshold for the raw score.
    expect(metricPassed("Hallucination", { score: 0.6, threshold: 0.7 })).toBe(false);
    expect(metricPassed("Hallucination", { score: 0.2, threshold: 0.7 })).toBe(true);
  });

  it("falls back to 0.5 for bare numbers", () => {
    expect(metricPassed("Toxicity", 0.4)).toBe(true);
    expect(metricPassed("Toxicity", 0.6)).toBe(false);
    expect(metricPassed("Relevance", 0.5)).toBe(true);
  });

  it("fails an errored metric", () => {
    expect(metricPassed("Faithfulness", { score: null, passed: false, error: "timeout" })).toBe(
      false,
    );
    expect(metricPassed("Faithfulness", undefined)).toBe(false);
  });
});

describe("isSkipped", () => {
  it("is true only for metrics the evaluator skipped", () => {
    expect(isSkipped({ score: null, passed: false, skipped: true })).toBe(true);
    expect(isSkipped({ score: null, passed: false, error: "timeout" })).toBe(false);
    expect(isSkipped({ score: 0, passed: true })).toBe(false);
    expect(isSkipped(0.7)).toBe(false);
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
