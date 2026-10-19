import { describe, expect, it } from "vitest";
import { isScored, lowerIsBetter, metricPassed } from "../metricScore";

describe("lowerIsBetter", () => {
  it("covers bias, toxicity and hallucination in any naming", () => {
    expect(lowerIsBetter("Bias")).toBe(true);
    expect(lowerIsBetter("toxicity")).toBe(true);
    expect(lowerIsBetter("G-Eval (Hallucination)")).toBe(true);
    expect(lowerIsBetter("Correctness")).toBe(false);
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

  it("falls back to the stored threshold in the metric's direction", () => {
    expect(metricPassed("Correctness", { score: 0.6, threshold: 0.8 })).toBe(false);
    expect(metricPassed("Correctness", { score: 0.85, threshold: 0.8 })).toBe(true);
    expect(metricPassed("Bias", { score: 0.3, threshold: 0.2 })).toBe(false);
    expect(metricPassed("Bias", { score: 0.1, threshold: 0.2 })).toBe(true);
  });

  it("falls back to 0.5 for bare numbers", () => {
    expect(metricPassed("Toxicity", 0.4)).toBe(true);
    expect(metricPassed("Toxicity", 0.6)).toBe(false);
    expect(metricPassed("Relevance", 0.5)).toBe(true);
  });

  it("does not pass a metric without a score or flag", () => {
    expect(metricPassed("Faithfulness", { score: null })).toBe(false);
    expect(metricPassed("Faithfulness", undefined)).toBe(false);
  });
});

describe("isScored", () => {
  it("leaves out skipped and errored metrics", () => {
    expect(isScored({ score: null, passed: false })).toBe(false);
    expect(isScored({ score: 0, passed: true })).toBe(true);
    expect(isScored(0.7)).toBe(true);
    expect(isScored(undefined)).toBe(false);
  });
});
