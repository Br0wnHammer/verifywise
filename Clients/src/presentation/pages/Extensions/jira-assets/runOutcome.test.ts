import { describe, expect, it } from "vitest";
import { isAbandonedRun } from "./runOutcome";

describe("isAbandonedRun", () => {
  it("reads latest_run.code, not error_message", () => {
    expect(isAbandonedRun({ code: "abandoned" })).toBe(true);
    expect(isAbandonedRun({ code: "skipped" })).toBe(false);
    expect(isAbandonedRun({ code: null })).toBe(false);
    expect(isAbandonedRun(null)).toBe(false);
  });
});
