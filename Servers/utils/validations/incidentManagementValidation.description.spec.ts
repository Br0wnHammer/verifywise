import {
  INCIDENT_DESCRIPTION_MAX_LENGTH,
  INCIDENT_VALIDATION_LIMITS,
  validateDescription,
} from "./incidentManagementValidation.utils";

describe("incident description length", () => {
  it("caps descriptions at Jira's 32,767-character text-field limit", () => {
    expect(INCIDENT_DESCRIPTION_MAX_LENGTH).toBe(32767);
    expect(INCIDENT_VALIDATION_LIMITS.DESCRIPTION.MAX).toBe(INCIDENT_DESCRIPTION_MAX_LENGTH);
    expect(INCIDENT_VALIDATION_LIMITS.DESCRIPTION.MIN).toBe(5);
  });

  it("accepts descriptions over the old 1,000-character cap", () => {
    expect(validateDescription("a".repeat(1001)).isValid).toBe(true);
    expect(validateDescription("a".repeat(5000)).isValid).toBe(true);
  });

  it("accepts exactly 32,767 characters", () => {
    expect(validateDescription("a".repeat(32767)).isValid).toBe(true);
  });

  it("rejects 32,768 characters", () => {
    const result = validateDescription("a".repeat(32768));
    expect(result.isValid).toBe(false);
    expect(result.message).toBe("Description cannot exceed 32767 characters");
  });

  it("still rejects descriptions shorter than 5 characters", () => {
    expect(validateDescription("abcd").isValid).toBe(false);
    expect(validateDescription("abcde").isValid).toBe(true);
  });
});
