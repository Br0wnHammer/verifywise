/**
 * Incident Management specific validation utilities
 * Contains validation schemas and functions specifically for AI incident reporting and compliance (EU AI Act Article 73)
 */

import {
  AIIncidentManagementStatus,
  AIIncidentManagementApprovalStatus,
} from "../../domain.layer/enums/ai-incident-management.enum";
import {
  validateString,
  validateEnum,
  validateDate,
  validateForeignKey,
  validateSchema,
  ValidationResult,
  ValidationError,
} from "./validation.utils";

/**
 * Validation limits for incident management
 */
export const INCIDENT_VALIDATION_LIMITS = {
  DESCRIPTION: { MIN: 5, MAX: 1000 },
  RELATIONSHIP: { MIN: 3, MAX: 255 },
  PROJECT: { MIN: 2, MAX: 255 },
  REPORTER: { MIN: 2, MAX: 100 },
} as const;

/**
 * Incident severity levels
 */
export const INCIDENT_SEVERITY_ENUM = ["Minor", "Serious", "Very Serious"] as const;

/**
 * Incident status values
 */
export const INCIDENT_STATUS_ENUM = [
  "Open",
  "Investigating",
  "Mitigated",
  "Closed",
  "Suspended",
  "Emergency action",
] as const;

/**
 * Approval status values
 */
export const APPROVAL_STATUS_ENUM = ["Pending", "Approved", "Rejected", "Not Required"] as const;

/**
 * Categories of harm per EU AI Act Article 73
 */
export const INCIDENT_HARM_CATEGORIES_ENUM = [
  "Health and Safety",
  "Fundamental Rights Violation",
  "Environmental Impact",
  "Economic Loss",
  "Privacy or Data Breach",
  "Security Threat",
  "Other",
] as const;

/**
 * Validates description
 */
export const validateDescription = (value: any): ValidationResult => {
  return validateString(value, "Description", {
    required: true,
    minLength: INCIDENT_VALIDATION_LIMITS.DESCRIPTION.MIN,
    maxLength: INCIDENT_VALIDATION_LIMITS.DESCRIPTION.MAX,
    trimWhitespace: true,
  });
};

/**
 * Validates categories of harm
 */
export const validateCategoriesOfHarm = (value: any): ValidationResult => {
  if (!Array.isArray(value) || value.length < 1) {
    return {
      isValid: false,
      message: "At least one harm category is required",
      code: "REQUIRED_FIELD",
    };
  }

  for (const category of value) {
    if (!INCIDENT_HARM_CATEGORIES_ENUM.includes(category as any)) {
      return {
        isValid: false,
        message: `Invalid harm category: "${category}". Must be one of: ${INCIDENT_HARM_CATEGORIES_ENUM.join(", ")}`,
        code: "INVALID_HARM_CATEGORY",
      };
    }
  }

  return { isValid: true };
};

/**
 * Validates relationship/causality
 */
export const validateRelationship = (value: any): ValidationResult => {
  return validateString(value, "Relationship/Causality", {
    required: true,
    minLength: INCIDENT_VALIDATION_LIMITS.RELATIONSHIP.MIN,
    maxLength: INCIDENT_VALIDATION_LIMITS.RELATIONSHIP.MAX,
    trimWhitespace: true,
  });
};

/**
 * Validates AI project/system field
 */
export const validateAIProject = (value: any): ValidationResult => {
  return validateString(value, "AI Project/System", {
    required: true,
    minLength: INCIDENT_VALIDATION_LIMITS.PROJECT.MIN,
    maxLength: INCIDENT_VALIDATION_LIMITS.PROJECT.MAX,
    trimWhitespace: true,
  });
};

/**
 * Validates severity level
 */
export const validateSeverity = (value: any): ValidationResult => {
  return validateEnum(value, "Severity Level", INCIDENT_SEVERITY_ENUM, true);
};

/**
 * Validates status
 */
export const validateStatus = (value: any): ValidationResult => {
  return validateEnum(value, "Status", INCIDENT_STATUS_ENUM, true);
};

/**
 * Validates approval status
 */
export const validateApprovalStatus = (value: any): ValidationResult => {
  return validateEnum(value, "Approval Status", APPROVAL_STATUS_ENUM, true);
};

/**
 * Validates date occurred
 */
export const validateDateOccurred = (value: any): ValidationResult => {
  return validateDate(value, "Date Occurred", { required: true });
};

/**
 * Validates date detected
 */
export const validateDateDetected = (value: any): ValidationResult => {
  return validateDate(value, "Date Detected", { required: true });
};

/**
 * Validates reporter field
 */
export const validateReporter = (value: any): ValidationResult => {
  return validateString(value, "Reporter", {
    required: true,
    minLength: INCIDENT_VALIDATION_LIMITS.REPORTER.MIN,
    maxLength: INCIDENT_VALIDATION_LIMITS.REPORTER.MAX,
    trimWhitespace: true,
  });
};

/**
 * Validates approver field (foreign key)
 */
export const validateApprover = (value: any): ValidationResult => {
  return validateForeignKey(value, "Approver", false);
};

/**
 * Validates an optional incident reference FK (issue #4583).
 * Accepts undefined/null/"" (no link) but rejects non-integers and 0
 * (0 is not a valid primary key and would fail the FK constraint).
 */
export const validateOptionalIncidentReference = (value: any, field: string): ValidationResult => {
  if (value === undefined || value === null || value === "") {
    return { isValid: true };
  }
  const numValue = Number(value);
  if (isNaN(numValue) || !Number.isInteger(numValue) || numValue < 1) {
    return {
      isValid: false,
      message: `${field} must be a positive integer ID`,
      code: "INVALID_ID",
    };
  }
  return { isValid: true };
};

export const validateModelInventoryId = (value: any): ValidationResult =>
  validateOptionalIncidentReference(value, "Model inventory ID");

export const validateProjectId = (value: any): ValidationResult =>
  validateOptionalIncidentReference(value, "Project ID");

export const validateAssigneeId = (value: any): ValidationResult =>
  validateOptionalIncidentReference(value, "Assignee ID");

/**
 * Validation schema for creating an incident
 */
export const createIncidentSchema = {
  model_inventory_id: validateModelInventoryId,
  project_id: validateProjectId,
  assignee_id: validateAssigneeId,
};

/**
 * Validation schema for updating an incident
 */
export const updateIncidentSchema = {
  model_inventory_id: validateModelInventoryId,
  project_id: validateProjectId,
  assignee_id: validateAssigneeId,
};

export const validateIncidentIdParam = (id: any): ValidationResult => {
  return validateForeignKey(id, "Incident ID", true);
};

/**
 * Validates a complete incident for creation
 */
export const validateCompleteIncident = (data: any): ValidationError[] => {
  return validateSchema(data, createIncidentSchema);
};

/**
 * Validates a complete incident for update
 */
export const validateUpdateIncident = (data: any): ValidationError[] => {
  return validateSchema(data, updateIncidentSchema);
};

/**
 * Business rule validation for incident creation
 */
export const validateIncidentCreationBusinessRules = (data: any): ValidationError[] => {
  const errors: ValidationError[] = [];

  if (new Date(data.date_detected) < new Date(data.date_occurred)) {
    errors.push({
      field: "date_detected",
      message: "Date detected cannot be earlier than date occurred",
      code: "INVALID_DATE_ORDER",
    });
  }

  return errors;
};

/**
 * Business rule validation for incident updates
 */
export const validateIncidentUpdateBusinessRules = (
  _data: any,
  _existingData?: any,
): ValidationError[] => {
  // Any status can move to any other status, including Closed back to an
  // open status (reopening). See applyReopenApprovalReset for the approval
  // side effect of a reopen.
  return [];
};

/** Approval fields a caller can set; touching any of them disables the reopen reset. */
const APPROVAL_FIELDS = [
  "approval_status",
  "approved_by",
  "approval_date",
  "approval_notes",
] as const;

/** Incident date columns. Compared as calendar dates (see incidentCalendarDate). */
export const INCIDENT_DATE_COLUMNS: ReadonlySet<string> = new Set([
  "occurred_date",
  "date_detected",
  "approval_date",
]);

/** Incident foreign-key columns (issue #4583). Compared as numbers. */
export const INCIDENT_FK_COLUMNS: ReadonlySet<string> = new Set([
  "model_inventory_id",
  "project_id",
  "assignee_id",
]);

/** Incident boolean columns. null / undefined count as false. */
export const INCIDENT_BOOLEAN_COLUMNS: ReadonlySet<string> = new Set([
  "archived",
  "interim_report",
]);

const isEmptyValue = (value: unknown): boolean =>
  value === null || value === undefined || value === "";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The calendar date (YYYY-MM-DD) of an incident date value, read as the
 * wall-clock date stored in the TIMESTAMP WITHOUT TIME ZONE column.
 *
 * - A Date comes from pg, which parses this column type (oid 1114) as
 *   server-local time and the project installs no custom type parser, so its
 *   local components are the stored wall-clock time.
 * - A string starting with YYYY-MM-DD is that date: it is what Postgres
 *   stores for it, since this column type ignores any offset in the input.
 *
 * Both readings agree in any server time zone. The model serialises these
 * columns as wall-clock time too (AIIncidentManagementModel.toSafeJSON), so
 * the date the edit drawer sends back compares equal.
 */
export const incidentCalendarDate = (value: unknown): string | null => {
  if (isEmptyValue(value)) return null;
  if (typeof value === "string") {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
    if (match) return match[0];
  }
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

const toHarmArray = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Whether `sent` would store the same value incident column `column` already
 * holds (`stored`). This is the one comparison used both to decide whether a
 * caller touched an approval field (applyReopenApprovalReset) and to decide
 * which columns an update writes and records in history
 * (diffIncidentColumns).
 *
 * '' / null / undefined are all "empty"; booleans treat empty as false; date
 * columns compare calendar dates; foreign keys compare numerically.
 */
export const isSameIncidentValue = (column: string, stored: unknown, sent: unknown): boolean => {
  if (INCIDENT_BOOLEAN_COLUMNS.has(column)) return Boolean(stored) === Boolean(sent);
  if (isEmptyValue(stored) || isEmptyValue(sent)) {
    return isEmptyValue(stored) && isEmptyValue(sent);
  }
  if (INCIDENT_DATE_COLUMNS.has(column)) {
    return incidentCalendarDate(stored) === incidentCalendarDate(sent);
  }
  if (INCIDENT_FK_COLUMNS.has(column)) return Number(stored) === Number(sent);
  if (column === "categories_of_harm") {
    return JSON.stringify(toHarmArray(stored)) === JSON.stringify(toHarmArray(sent));
  }
  if (typeof stored === "object" || typeof sent === "object") {
    return JSON.stringify(stored) === JSON.stringify(sent);
  }
  return String(stored) === String(sent);
};

/**
 * Approval on an incident is sign-off on its closure. When a Closed incident
 * is reopened (status moves from Closed to anything else) and its stored
 * approval is Approved, that sign-off no longer describes it, so the update
 * is rewritten to approval_status Pending with approved_by, approval_date and
 * approval_notes cleared. Change history keeps the old values. Pending,
 * Rejected and Not required approvals are left alone.
 *
 * If the update itself changes any approval field (a value that differs from
 * the stored one), the caller has made an explicit approval decision and the
 * update is kept as sent. A field sent back with its stored value counts as
 * "not touched" (the edit form always sends every field), so keeping an
 * incident Approved through a reopen takes a deliberate re-approval in a
 * later update.
 *
 * Returns the update unchanged when no reset applies, otherwise a copy.
 */
export const applyReopenApprovalReset = <T extends Record<string, any>>(
  existing: Record<string, any>,
  update: T,
): T => {
  const isReopen =
    existing.status === AIIncidentManagementStatus.CLOSED &&
    update.status !== undefined &&
    update.status !== AIIncidentManagementStatus.CLOSED;
  if (!isReopen || existing.approval_status !== AIIncidentManagementApprovalStatus.APPROVED) {
    return update;
  }

  const callerChangedApproval = APPROVAL_FIELDS.some(
    (field) =>
      update[field] !== undefined && !isSameIncidentValue(field, existing[field], update[field]),
  );
  if (callerChangedApproval) return update;

  return {
    ...update,
    approval_status: AIIncidentManagementApprovalStatus.PENDING,
    approved_by: null,
    approval_date: null,
    approval_notes: null,
  };
};

/**
 * Complete validation for incident creation
 */
export const validateCompleteIncidentCreation = (data: any): ValidationError[] => {
  const validationErrors = validateCompleteIncident(data);
  const businessErrors = validateIncidentCreationBusinessRules(data);
  return [...validationErrors, ...businessErrors];
};

/**
 * Complete validation for incident update
 */
export const validateCompleteIncidentUpdate = (
  data: any,
  existingData?: any,
): ValidationError[] => {
  const validationErrors = validateUpdateIncident(data);
  const businessErrors = validateIncidentUpdateBusinessRules(data, existingData);
  return [...validationErrors, ...businessErrors];
};
