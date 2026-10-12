import {
  applyReopenApprovalReset,
  validateCompleteIncidentUpdate,
} from "./incidentManagementValidation.utils";

describe("reopening closed incidents", () => {
  describe("validateCompleteIncidentUpdate", () => {
    it.each(["Open", "Investigating", "Mitigated", "Suspended", "Emergency action"])(
      "allows Closed → %s",
      (status) => {
        expect(validateCompleteIncidentUpdate({ status }, { status: "Closed" })).toEqual([]);
      },
    );
  });

  describe("applyReopenApprovalReset", () => {
    const closedApproved = { status: "Closed", approval_status: "Approved" };

    it("resets an Approved closure sign-off to Pending on reopen", () => {
      const result = applyReopenApprovalReset(closedApproved, { status: "Investigating" });
      expect(result).toEqual({
        status: "Investigating",
        approval_status: "Pending",
        approved_by: null,
        approval_date: null,
      });
    });

    it("treats an unchanged approval_status from the edit form as not touched", () => {
      const update = {
        status: "Open",
        approval_status: "Approved",
        approved_by: "Jane Doe",
        approval_date: "2026-10-01T00:00:00.000Z",
        approval_notes: "Closure signed off",
      };
      const result = applyReopenApprovalReset(closedApproved, update);
      expect(result).toEqual({
        ...update,
        approval_status: "Pending",
        approved_by: null,
        approval_date: null,
      });
    });

    it("keeps an approval_status the caller explicitly changed in the same update", () => {
      const update = { status: "Investigating", approval_status: "Not Required" };
      expect(applyReopenApprovalReset(closedApproved, update)).toBe(update);
    });

    it.each(["Pending", "Rejected", "Not Required"])(
      "leaves a %s approval alone on reopen",
      (approval_status) => {
        const update = { status: "Investigating" };
        expect(applyReopenApprovalReset({ status: "Closed", approval_status }, update)).toBe(
          update,
        );
      },
    );

    it("does nothing when the incident stays Closed or the status is not in the update", () => {
      const stays = { status: "Closed", description: "More detail" };
      const noStatus = { description: "More detail" };
      expect(applyReopenApprovalReset(closedApproved, stays)).toBe(stays);
      expect(applyReopenApprovalReset(closedApproved, noStatus)).toBe(noStatus);
    });

    it("does nothing for status changes that are not a reopen", () => {
      const update = { status: "Closed" };
      expect(
        applyReopenApprovalReset({ status: "Mitigated", approval_status: "Approved" }, update),
      ).toBe(update);
    });
  });
});
