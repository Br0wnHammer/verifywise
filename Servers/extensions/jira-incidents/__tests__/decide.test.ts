import { decideStatusAction, pickTransition } from "../decide";

const maps = {
  statusMapIn: { "1": "Open", "3": "Investigating", "4": "Closed" },
  statusMapOut: {
    Open: "1",
    Investigating: "3",
    Closed: "4",
    Mitigated: null,
    Suspended: null,
    "Emergency action": null,
  },
};
const base = {
  lastJiraStatusId: "1",
  lastVwStatus: "Open",
  jiraStatusId: "1",
  vwStatus: "Open",
  jiraChangedAt: null,
  vwChangedAt: null,
  ...maps,
};
const t = (iso: string) => new Date(iso);

describe("decideStatusAction", () => {
  it("does nothing when neither side changed", () => {
    expect(decideStatusAction(base)).toEqual({ action: "none" });
  });
  it("applies a Jira change to VerifyWise", () => {
    expect(decideStatusAction({ ...base, jiraStatusId: "3" })).toEqual({
      action: "to_vw",
      vwStatus: "Investigating",
      conflict: false,
    });
  });
  it("reports an unmapped Jira status", () => {
    expect(decideStatusAction({ ...base, jiraStatusId: "77" })).toEqual({
      action: "unmapped",
      jiraStatusId: "77",
    });
  });
  it("does nothing when the Jira change maps to the status VerifyWise already has", () => {
    expect(decideStatusAction({ ...base, lastJiraStatusId: "3", jiraStatusId: "1" })).toEqual({
      action: "none",
    });
  });
  it("applies a VerifyWise change to Jira", () => {
    expect(decideStatusAction({ ...base, vwStatus: "Closed" })).toEqual({
      action: "to_jira",
      jiraStatusId: "4",
      conflict: false,
    });
  });
  it("records Don't change Jira as a to_jira with no target", () => {
    expect(decideStatusAction({ ...base, vwStatus: "Mitigated" })).toEqual({
      action: "to_jira",
      jiraStatusId: null,
      conflict: false,
    });
  });
  it("lets the later change win when both changed", () => {
    const both = { ...base, jiraStatusId: "3", vwStatus: "Closed" };
    expect(
      decideStatusAction({
        ...both,
        jiraChangedAt: t("2026-10-14T10:00Z"),
        vwChangedAt: t("2026-10-14T11:00Z"),
      }),
    ).toEqual({ action: "to_jira", jiraStatusId: "4", conflict: true });
    expect(
      decideStatusAction({
        ...both,
        jiraChangedAt: t("2026-10-14T12:00Z"),
        vwChangedAt: t("2026-10-14T11:00Z"),
      }),
    ).toEqual({ action: "to_vw", vwStatus: "Investigating", conflict: true });
  });
  it("treats a missing time as oldest and gives a tie to Jira", () => {
    const both = { ...base, jiraStatusId: "3", vwStatus: "Closed" };
    expect(
      decideStatusAction({ ...both, jiraChangedAt: null, vwChangedAt: t("2026-10-14T11:00Z") })
        .action,
    ).toBe("to_jira");
    expect(
      decideStatusAction({
        ...both,
        jiraChangedAt: t("2026-10-14T11:00Z"),
        vwChangedAt: t("2026-10-14T11:00Z"),
      }).action,
    ).toBe("to_vw");
  });
  it("treats both sides changing to matching statuses as agreement, not a conflict", () => {
    expect(
      decideStatusAction({
        ...base,
        jiraStatusId: "4",
        vwStatus: "Closed",
        jiraChangedAt: t("2026-10-14T12:00Z"),
        vwChangedAt: t("2026-10-14T11:00Z"),
      }),
    ).toEqual({ action: "none" });
  });
  it("reports unmapped when Jira wins a conflict with an unmapped status", () => {
    expect(
      decideStatusAction({
        ...base,
        jiraStatusId: "77",
        vwStatus: "Closed",
        jiraChangedAt: t("2026-10-14T12:00Z"),
        vwChangedAt: t("2026-10-14T11:00Z"),
      }),
    ).toEqual({ action: "unmapped", jiraStatusId: "77" });
  });
  it("treats a link with no snapshot as unchanged on both sides", () => {
    expect(
      decideStatusAction({
        ...base,
        lastJiraStatusId: null,
        lastVwStatus: null,
        jiraStatusId: "3",
        vwStatus: "Closed",
      }),
    ).toEqual({ action: "none" });
  });
});

describe("pickTransition", () => {
  const names = { from: "Done", to: "In Progress" };
  it("picks the transition whose target is the mapped status", () => {
    expect(
      pickTransition(
        [{ id: "11", name: "Start", toStatusId: "3", requiredFields: [] }],
        "3",
        names,
      ),
    ).toEqual({ ok: true, transitionId: "11" });
  });
  it("explains when no transition reaches the status", () => {
    expect(pickTransition([], "3", names)).toEqual({
      ok: false,
      reason: "No move from 'Done' to 'In Progress' in this workflow",
    });
  });
  it("explains when the transition needs fields", () => {
    expect(
      pickTransition(
        [{ id: "11", name: "Resolve", toStatusId: "3", requiredFields: ["Resolution"] }],
        "3",
        names,
      ),
    ).toEqual({
      ok: false,
      reason: "Moving to 'In Progress' needs a value for Resolution. Change the status in Jira.",
    });
  });
});
