import {
  applyReopenApprovalReset,
  validateCompleteIncidentUpdate,
} from "./incidentManagementValidation.utils";
import {
  AIIncidentManagementApprovalStatus as Approval,
  AIIncidentManagementStatus as Status,
} from "../../domain.layer/enums/ai-incident-management.enum";

const RESET = {
  approval_status: Approval.PENDING,
  approved_by: null,
  approval_date: null,
  approval_notes: null,
};

describe("reopening closed incidents", () => {
  describe("validateCompleteIncidentUpdate", () => {
    it.each([
      Status.OPEN,
      Status.INVESTIGATING,
      Status.MITIGATED,
      Status.SUSPENDED,
      Status.EMERGENCY_ACTION,
    ])("allows Closed → %s", (status) => {
      expect(validateCompleteIncidentUpdate({ status }, { status: Status.CLOSED })).toEqual([]);
    });
  });

  describe("applyReopenApprovalReset", () => {
    const closedApproved = {
      status: Status.CLOSED,
      approval_status: Approval.APPROVED,
      approved_by: "Jane Doe",
      approval_date: "2026-10-01T00:00:00.000Z",
      approval_notes: "Closure signed off",
    };

    it("resets an Approved closure sign-off to Pending and clears approver, date and notes", () => {
      const result = applyReopenApprovalReset(closedApproved, { status: Status.INVESTIGATING });
      expect(result).toEqual({ status: Status.INVESTIGATING, ...RESET });
    });

    it("treats approval fields sent back unchanged (as the edit form does) as not touched", () => {
      const update = {
        status: Status.OPEN,
        approval_status: Approval.APPROVED,
        approved_by: "Jane Doe",
        // Same instant, different format.
        approval_date: new Date("2026-10-01T00:00:00.000Z"),
        approval_notes: "Closure signed off",
      };
      expect(applyReopenApprovalReset(closedApproved, update)).toEqual({
        ...update,
        ...RESET,
      });
    });

    it("treats '' and null as the same empty approval value", () => {
      const stored = { ...closedApproved, approval_notes: null };
      const update = { status: Status.OPEN, approval_notes: "" };
      expect(applyReopenApprovalReset(stored, update)).toEqual({ ...update, ...RESET });
    });

    it.each([
      ["approval_status", { approval_status: Approval.NOT_REQUIRED }],
      ["approved_by", { approved_by: "Sam Lee" }],
      ["approval_date", { approval_date: "2026-10-05T00:00:00.000Z" }],
      ["approval_notes", { approval_notes: "Still approved after review" }],
    ])("keeps the caller's approval fields when %s is changed explicitly", (_field, change) => {
      const update = { status: Status.INVESTIGATING, ...change };
      expect(applyReopenApprovalReset(closedApproved, update)).toBe(update);
    });

    it.each([Approval.PENDING, Approval.REJECTED, Approval.NOT_REQUIRED])(
      "leaves a %s approval alone on reopen",
      (approval_status) => {
        const update = { status: Status.INVESTIGATING };
        expect(applyReopenApprovalReset({ ...closedApproved, approval_status }, update)).toBe(
          update,
        );
      },
    );

    it("does nothing when the incident stays Closed or the status is not in the update", () => {
      const stays = { status: Status.CLOSED, description: "More detail" };
      const noStatus = { description: "More detail" };
      expect(applyReopenApprovalReset(closedApproved, stays)).toBe(stays);
      expect(applyReopenApprovalReset(closedApproved, noStatus)).toBe(noStatus);
    });

    it("does nothing for status changes that are not a reopen", () => {
      const update = { status: Status.CLOSED };
      expect(
        applyReopenApprovalReset({ ...closedApproved, status: Status.MITIGATED }, update),
      ).toBe(update);
    });
  });
});
