import type { StatusMapIn, StatusMapOut } from "./mapping";

export interface DecideInput {
  lastJiraStatusId: string | null;
  lastVwStatus: string | null;
  jiraStatusId: string;
  vwStatus: string;
  jiraChangedAt: Date | null;
  vwChangedAt: Date | null;
  statusMapIn: StatusMapIn;
  statusMapOut: StatusMapOut;
}

export type Decision =
  | { action: "none" }
  | { action: "to_vw"; vwStatus: string; conflict: boolean }
  | { action: "to_jira"; jiraStatusId: string | null; conflict: boolean }
  | { action: "unmapped"; jiraStatusId: string };

function toVw(input: DecideInput, conflict: boolean): Decision {
  const mapped = input.statusMapIn[input.jiraStatusId];
  if (!mapped) return { action: "unmapped", jiraStatusId: input.jiraStatusId };
  if (!conflict && mapped === input.vwStatus) return { action: "none" };
  return { action: "to_vw", vwStatus: mapped, conflict };
}

function toJira(input: DecideInput, conflict: boolean): Decision {
  const target = input.statusMapOut[input.vwStatus] ?? null;
  if (!conflict && target === input.jiraStatusId) return { action: "none" };
  return { action: "to_jira", jiraStatusId: target, conflict };
}

/**
 * The §6.2 table. A link with no snapshot (null last_*) counts as unchanged.
 * An empty Jira snapshot means the issue arrived in an unmapped status: Jira
 * counts as changed so a later mapping applies, unless VerifyWise changed and
 * Jira's changelog shows no status move at all, which is VerifyWise's change
 * alone and not a conflict.
 */
export function decideStatusAction(input: DecideInput): Decision {
  if (input.lastJiraStatusId === null || input.lastVwStatus === null) return { action: "none" };
  const vwChanged = input.vwStatus !== input.lastVwStatus;
  const unmappedAtImport = input.lastJiraStatusId === "";
  const jiraChanged =
    input.jiraStatusId !== input.lastJiraStatusId &&
    !(unmappedAtImport && vwChanged && input.jiraChangedAt === null);
  if (!jiraChanged && !vwChanged) return { action: "none" };
  if (jiraChanged && !vwChanged) return toVw(input, false);
  if (!jiraChanged && vwChanged) return toJira(input, false);
  // Both changed to statuses that already match (for example the admin made
  // a refused move by hand in Jira): nothing to apply, nothing to report.
  if (input.statusMapIn[input.jiraStatusId] === input.vwStatus) return { action: "none" };
  const jiraTime = input.jiraChangedAt?.getTime() ?? 0;
  const vwTime = input.vwChangedAt?.getTime() ?? 0;
  if (vwTime > jiraTime) {
    // VerifyWise wins, but Jira already holds its target: nothing to apply.
    if ((input.statusMapOut[input.vwStatus] ?? null) === input.jiraStatusId)
      return { action: "none" };
    return toJira(input, true);
  }
  return toVw(input, true);
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatusId: string;
  requiredFields: string[];
}

export function pickTransition(
  transitions: JiraTransition[],
  targetStatusId: string,
  names: { from: string; to: string },
): { ok: true; transitionId: string } | { ok: false; reason: string } {
  const matches = transitions.filter((tr) => tr.toStatusId === targetStatusId);
  if (matches.length === 0)
    return { ok: false, reason: `No move from '${names.from}' to '${names.to}' in this workflow` };
  // Prefer a transition that needs no fields; only report missing fields when every match needs some.
  const clean = matches.find((tr) => tr.requiredFields.length === 0);
  if (clean) return { ok: true, transitionId: clean.id };
  return {
    ok: false,
    reason: `Moving to '${names.to}' needs a value for ${matches[0].requiredFields.join(", ")}. Change the status in Jira.`,
  };
}
