import { describe, expect, it } from "vitest";
import {
  isAbandonedRun,
  isImportInterrupted,
  removalConflictText,
  REMOVAL_INTERRUPTED_MESSAGE,
  SYNC_RUNNING_MESSAGE,
} from "./runOutcome";

const conflict = (data: unknown) => ({ status: 409, response: { data } });

describe("isImportInterrupted", () => {
  it("is true only for a 409 with code import_interrupted", () => {
    expect(
      isImportInterrupted(conflict({ code: "import_interrupted", imported: 3, skipped: 0 })),
    ).toBe(true);
    // Counts alone, or a plain "sync running" 409, are not an interrupted import.
    expect(isImportInterrupted(conflict({ imported: 3 }))).toBe(false);
    expect(isImportInterrupted(conflict("A Jira Assets sync is already running"))).toBe(false);
    expect(
      isImportInterrupted({ status: 400, response: { data: { code: "import_interrupted" } } }),
    ).toBe(false);
    expect(isImportInterrupted(undefined)).toBe(false);
  });
});

describe("removalConflictText", () => {
  it("uses the server's message for code removal_interrupted, whatever its wording", () => {
    expect(
      removalConflictText(conflict({ code: "removal_interrupted", message: "Reworded by server" })),
    ).toBe("Reworded by server");
    expect(removalConflictText(conflict({ code: "removal_interrupted" }))).toBe(
      REMOVAL_INTERRUPTED_MESSAGE,
    );
  });

  it("treats any other 409 as a sync running, even if its text matches the old message", () => {
    expect(removalConflictText(conflict(REMOVAL_INTERRUPTED_MESSAGE))).toBe(SYNC_RUNNING_MESSAGE);
    expect(removalConflictText(conflict("busy"))).toBe(SYNC_RUNNING_MESSAGE);
  });

  it("returns null for anything that is not a 409", () => {
    expect(removalConflictText({ status: 500, response: { data: {} } })).toBeNull();
    expect(removalConflictText(new Error("network"))).toBeNull();
  });
});

describe("isAbandonedRun", () => {
  it("reads latest_run.code, not error_message", () => {
    expect(isAbandonedRun({ code: "abandoned" })).toBe(true);
    expect(isAbandonedRun({ code: "skipped" })).toBe(false);
    expect(isAbandonedRun({ code: null })).toBe(false);
    expect(isAbandonedRun(null)).toBe(false);
  });
});
