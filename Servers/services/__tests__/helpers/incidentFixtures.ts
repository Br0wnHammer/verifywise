/**
 * Incident fixtures shared by the incident update tests.
 */
import {
  AIIncidentManagementApprovalStatus as Approval,
  AIIncidentManagementStatus as Status,
} from "../../../domain.layer/enums/ai-incident-management.enum";

export const STORED_UPDATED_AT = new Date("2026-10-10T12:34:56.789Z");

/**
 * A stored Closed + Approved incident as getIncidentByIdQuery returns it:
 * date columns are JS Dates (TIMESTAMP WITHOUT TIME ZONE through pg), and
 * the model exposes both fields and dataValues plus toSafeJSON.
 */
export function storedIncident() {
  const values: Record<string, any> = {
    id: 42,
    incident_id: "INC-42",
    ai_project: "Chatbot",
    project_id: 3,
    model_inventory_id: null,
    assignee_id: 7,
    type: "Malfunction",
    severity: "Serious",
    status: Status.CLOSED,
    occurred_date: new Date("2026-09-20T00:00:00.000Z"),
    date_detected: new Date("2026-09-21T00:00:00.000Z"),
    reporter: "Ada",
    categories_of_harm: ["Economic Loss"],
    affected_persons_groups: null,
    description: "Model produced unsafe output",
    relationship_causality: null,
    immediate_mitigations: null,
    planned_corrective_actions: null,
    model_system_version: null,
    interim_report: false,
    archived: false,
    approval_status: Approval.APPROVED,
    approved_by: "Jane Doe",
    approval_date: new Date("2026-10-01T00:00:00.000Z"),
    approval_notes: "Closure signed off",
    updated_at: STORED_UPDATED_AT,
  };
  const toSafeJSON = () => {
    const json: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      json[key] = value instanceof Date ? value.toISOString() : value;
    }
    return json;
  };
  return { ...values, dataValues: values, toSafeJSON };
}

/**
 * The exact body the edit drawer sends for `stored` with only the status
 * changed: IncidentManagement/index.tsx builds initialData from the API JSON
 * and NewIncident handleSaveIncident spreads it, normalising FK pickers to
 * numbers or null.
 */
export function drawerPayload(stored: Record<string, any>, status: string) {
  const day = (d: Date | string) => new Date(d).toISOString().split("T")[0];
  const toId = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    incident_id: stored.incident_id || "",
    ai_project: stored.ai_project || "",
    project_id: toId(stored.project_id ?? ""),
    model_inventory_id: toId(stored.model_inventory_id ?? ""),
    assignee_id: toId(stored.assignee_id ?? ""),
    type: stored.type || "",
    severity: stored.severity || "",
    status,
    occurred_date: day(stored.occurred_date),
    date_detected: day(stored.date_detected),
    reporter: stored.reporter,
    categories_of_harm: stored.categories_of_harm || [],
    description: stored.description,
    affected_persons_groups: stored.affected_persons_groups || "",
    relationship_causality: stored.relationship_causality || "",
    immediate_mitigations: stored.immediate_mitigations || "",
    planned_corrective_actions: stored.planned_corrective_actions || "",
    model_system_version: stored.model_system_version,
    interim_report: stored.interim_report || false,
    approval_status: stored.approval_status,
    approved_by: stored.approved_by,
    approval_date: stored.approval_date ? day(stored.approval_date) : null,
    approval_notes: stored.approval_notes,
    expected_updated_at: stored.updated_at ? new Date(stored.updated_at).toISOString() : undefined,
  };
}
