/**
 * Incident fixtures shared by the incident update tests.
 *
 * storedIncident() is built the way getIncidentByIdQuery builds a row
 * (sequelize.query with mapToModel): the raw SELECT columns are renamed with
 * the model's fieldAttributeMap and passed to the real model's bulkBuild. So
 * the timestamps land where they do in production (updated_at → updatedAt,
 * because the model has timestamps + underscored) and this cannot drift
 * from the real mapping.
 */
import { Sequelize } from "sequelize-typescript";
import { AIIncidentManagementModel } from "../../../domain.layer/models/incidentManagement/incidemtManagement.model";
import {
  AIIncidentManagementApprovalStatus as Approval,
  AIIncidentManagementStatus as Status,
} from "../../../domain.layer/enums/ai-incident-management.enum";

export const STORED_UPDATED_AT = new Date("2026-10-10T12:34:56.789Z");

/**
 * A TIMESTAMP WITHOUT TIME ZONE value as pg returns it: the stored
 * wall-clock time parsed as server-local time.
 */
export const pgTimestamp = (y: number, m: number, d: number, hh = 0, mm = 0): Date =>
  new Date(y, m - 1, d, hh, mm);

let modelReady = false;

/** Mirrors handleSelectQuery for `mapToModel: true` (sequelize abstract/query.js). */
export function mapIncidentRow(row: Record<string, unknown>): AIIncidentManagementModel {
  if (!modelReady) {
    // Registers the model's attributes; nothing connects to a database.
    new Sequelize({ dialect: "postgres", logging: false, models: [AIIncidentManagementModel] });
    modelReady = true;
  }
  const fieldMap: Record<string, string> =
    (AIIncidentManagementModel as unknown as { fieldAttributeMap?: Record<string, string> })
      .fieldAttributeMap ?? {};
  const mapped: Record<string, unknown> = { ...row };
  for (const [field, name] of Object.entries(fieldMap)) {
    if (mapped[field] !== undefined && name !== field) {
      mapped[name] = mapped[field];
      delete mapped[field];
    }
  }
  return AIIncidentManagementModel.bulkBuild([mapped as any], {
    isNewRecord: false,
    raw: true,
  })[0];
}

/** The raw `SELECT i.*, ...` row for a stored Closed + Approved incident. */
export function storedIncidentRow(): Record<string, unknown> {
  return {
    id: 42,
    incident_id: "INC-42",
    ai_project: "Chatbot",
    project_id: 3,
    model_inventory_id: null,
    assignee_id: 7,
    type: "Malfunction",
    severity: "Serious",
    status: Status.CLOSED,
    occurred_date: pgTimestamp(2026, 9, 20),
    date_detected: pgTimestamp(2026, 9, 21),
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
    approval_date: pgTimestamp(2026, 10, 1),
    approval_notes: "Closure signed off",
    is_demo: false,
    organization_id: 1,
    created_at: new Date("2026-09-21T09:00:00.000Z"),
    updated_at: STORED_UPDATED_AT,
    // Joined display columns from INCIDENT_SELECT.
    model_inventory_name: null,
    project_title: "Chatbot",
    assignee_name: "Grace Hopper",
  };
}

/** A stored Closed + Approved incident exactly as getIncidentByIdQuery returns it. */
export function storedIncident(): AIIncidentManagementModel {
  return mapIncidentRow(storedIncidentRow());
}

/**
 * The exact body the edit drawer sends for an incident whose API JSON is
 * `json` (toSafeJSON), with only the status changed: IncidentManagement
 * index.tsx builds initialData from that JSON and NewIncident
 * handleSaveIncident spreads it, normalising FK pickers to numbers or null.
 */
export function drawerPayload(json: Record<string, any>, status: string) {
  const day = (d: string) => new Date(d).toISOString().split("T")[0];
  const toId = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  return {
    incident_id: json.incident_id || "",
    ai_project: json.ai_project || "",
    project_id: toId(json.project_id ?? ""),
    model_inventory_id: toId(json.model_inventory_id ?? ""),
    assignee_id: toId(json.assignee_id ?? ""),
    type: json.type || "",
    severity: json.severity || "",
    status,
    occurred_date: day(json.occurred_date),
    date_detected: day(json.date_detected),
    reporter: json.reporter,
    categories_of_harm: json.categories_of_harm || [],
    description: json.description,
    affected_persons_groups: json.affected_persons_groups || "",
    relationship_causality: json.relationship_causality || "",
    immediate_mitigations: json.immediate_mitigations || "",
    planned_corrective_actions: json.planned_corrective_actions || "",
    model_system_version: json.model_system_version,
    interim_report: json.interim_report || false,
    approval_status: json.approval_status,
    approved_by: json.approved_by,
    approval_date: json.approval_date ? day(json.approval_date) : null,
    approval_notes: json.approval_notes,
    expected_updated_at: json.updated_at ? new Date(json.updated_at).toISOString() : undefined,
  };
}
