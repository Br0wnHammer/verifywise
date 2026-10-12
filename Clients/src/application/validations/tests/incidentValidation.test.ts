import { describe, it, expect } from "vitest";
import {
  INCIDENT_DESCRIPTION_MAX_LENGTH,
  INCIDENT_DESCRIPTION_TOO_LONG_MESSAGE,
  validateIncidentDescription,
} from "../incidentValidation";

describe("validateIncidentDescription", () => {
  it("uses Jira's 32,767-character text-field limit", () => {
    expect(INCIDENT_DESCRIPTION_MAX_LENGTH).toBe(32767);
    // Must match the translations.ts key exactly.
    expect(INCIDENT_DESCRIPTION_TOO_LONG_MESSAGE).toBe(
      "Description cannot exceed 32,767 characters.",
    );
  });

  it("requires a value", () => {
    expect(validateIncidentDescription("")).toBe("Description is required.");
    expect(validateIncidentDescription(undefined)).toBe("Description is required.");
  });

  it("accepts descriptions over the old 1,000-character cap", () => {
    expect(validateIncidentDescription("a".repeat(1001))).toBe("");
    expect(validateIncidentDescription("a".repeat(5000))).toBe("");
  });

  it("accepts exactly 32,767 characters", () => {
    expect(validateIncidentDescription("a".repeat(32767))).toBe("");
  });

  it("rejects 32,768 characters", () => {
    expect(validateIncidentDescription("a".repeat(32768))).toBe(
      INCIDENT_DESCRIPTION_TOO_LONG_MESSAGE,
    );
  });

  it("measures length after trimming, like the backend", () => {
    expect(validateIncidentDescription(`  ${"a".repeat(32767)}  `)).toBe("");
  });
});
