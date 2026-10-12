/**
 * Shared write path for updating an AI incident.
 *
 * Every caller that changes an existing incident (the HTTP controller and
 * the AI Advisor tools today, integrations such as issue-tracker sync next)
 * goes through updateIncident so the same rules apply everywhere:
 *   1. the row is loaded once, locked FOR UPDATE inside the transaction;
 *   2. optional optimistic-concurrency check (expectedUpdatedAt);
 *   3. validation against the locked row;
 *   4. reopening a Closed incident drops a stale Approved closure sign-off
 *      (applyReopenApprovalReset);
 *   5. one diff (diffIncidentColumns) decides which columns are written and
 *      which fields are recorded in change history; nothing changed means no
 *      write, no updated_at bump, no history and no automations;
 *   6. `incident_updated` automations are enqueued only after commit.
 */

import { Transaction } from "sequelize";
import { sequelize } from "../database/db";
import { AIIncidentManagementModel } from "../domain.layer/models/incidentManagement/incidemtManagement.model";
import { ConflictException } from "../domain.layer/exceptions/custom.exception";
import {
  diffIncidentColumns,
  enqueueIncidentUpdatedAutomations,
  getIncidentByIdQuery,
  updateIncidentByIdQuery,
  validateIncidentReferences,
} from "../utils/incidentManagement.utils";
import {
  applyReopenApprovalReset,
  validateCompleteIncidentUpdate,
} from "../utils/validations/incidentManagementValidation.utils";
import { ValidationError } from "../utils/validations/validation.utils";
import {
  formatEntityFieldChanges,
  recordMultipleFieldChanges,
} from "../utils/changeHistory.base.utils";
import logger from "../utils/logger/fileLogger";

/** Message for a write that lost an optimistic-concurrency check. */
export const INCIDENT_CHANGED_MESSAGE =
  "This incident was changed since you opened it. Reload to see the latest version.";

/** Thrown when an update fails validation; `errors` match the HTTP 400 body. */
export class IncidentUpdateValidationError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super("Incident update validation failed");
    this.name = "IncidentUpdateValidationError";
  }
}

export interface UpdateIncidentOptions {
  /** Run inside the caller's transaction; the caller commits or rolls back. */
  transaction?: Transaction;
  /**
   * Record history as a system change (null actor, changed_by_system = true)
   * rather than as `userId`. Meant for writers that act for no person, such
   * as integrations and background jobs.
   */
  changedBySystem?: boolean;
  /**
   * The incident's updated_at as the caller last saw it. When given and the
   * stored value differs, the update is refused with a ConflictException
   * (HTTP 409). Interactive editors pass it; background writers do not.
   */
  expectedUpdatedAt?: string | Date;
}

const sameInstant = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return new Date(a as string).getTime() === new Date(b as string).getTime();
};

/**
 * Applies `updates` to incident `incidentId`. Returns the updated incident
 * (or the unchanged one when nothing differs), or null when it does not
 * exist in the organization.
 *
 * Throws ConflictException when `expectedUpdatedAt` is stale and
 * IncidentUpdateValidationError when the update is invalid.
 *
 * History is recorded as `userId`, or as the system when
 * `options.changedBySystem` is set. With neither, no history is written.
 */
export async function updateIncident(
  organizationId: number,
  incidentId: number,
  updates: Record<string, unknown>,
  userId: number | null | undefined,
  options: UpdateIncidentOptions = {},
): Promise<AIIncidentManagementModel | null> {
  const ownsTransaction = !options.transaction;
  const transaction = options.transaction ?? (await sequelize.transaction());
  try {
    const existing = (await getIncidentByIdQuery(incidentId, organizationId, {
      transaction,
      lock: true,
    })) as AIIncidentManagementModel | null;
    if (!existing) {
      if (ownsTransaction) await transaction.rollback();
      return null;
    }
    const stored = existing.dataValues as unknown as Record<string, unknown>;

    if (
      options.expectedUpdatedAt !== undefined &&
      !sameInstant(stored.updated_at, options.expectedUpdatedAt)
    ) {
      throw new ConflictException(INCIDENT_CHANGED_MESSAGE, "incident", "updated_at");
    }

    const validationErrors: ValidationError[] = validateCompleteIncidentUpdate(updates, stored);
    const invalidRefs = await validateIncidentReferences(
      {
        model_inventory_id: (updates.model_inventory_id !== undefined
          ? updates.model_inventory_id
          : stored.model_inventory_id) as number | null,
        project_id: (updates.project_id !== undefined ? updates.project_id : stored.project_id) as
          number | null,
        assignee_id: (updates.assignee_id !== undefined
          ? updates.assignee_id
          : stored.assignee_id) as number | null,
      },
      organizationId,
      transaction,
    );
    for (const field of invalidRefs) {
      validationErrors.push({
        field,
        message: `${field} does not reference an entity in your organization`,
        code: "INVALID_REFERENCE",
      });
    }
    if (validationErrors.length > 0) throw new IncidentUpdateValidationError(validationErrors);

    const effective = applyReopenApprovalReset(stored, updates);
    const changed = diffIncidentColumns(stored, effective);
    const changedColumns = Object.keys(changed);

    if (changedColumns.length === 0) {
      if (ownsTransaction) await transaction.commit();
      return existing;
    }

    const saved = await updateIncidentByIdQuery(incidentId, changed, organizationId, transaction);

    if (userId || options.changedBySystem) {
      const changes = await formatEntityFieldChanges("incident", stored, changed, changedColumns);
      if (changes.length > 0) {
        await recordMultipleFieldChanges(
          "incident",
          incidentId,
          userId ?? null,
          organizationId,
          changes,
          transaction,
          options.changedBySystem ?? false,
        );
      }
    }

    transaction.afterCommit(() => {
      enqueueIncidentUpdatedAutomations(organizationId, existing, saved).catch((error) =>
        logger.error(`[incident] automation enqueue failed for #${incidentId}: ${error}`),
      );
    });

    if (ownsTransaction) await transaction.commit();
    return saved;
  } catch (error) {
    if (ownsTransaction) await transaction.rollback();
    throw error;
  }
}
