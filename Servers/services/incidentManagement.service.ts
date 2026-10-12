/**
 * Shared write path for updating an AI incident.
 *
 * Every caller that changes an existing incident — the HTTP controller, the
 * AI Advisor tools, and integrations such as issue-tracker sync — goes
 * through updateIncident so the same rules apply everywhere:
 *   1. the row is loaded once, locked FOR UPDATE inside the transaction;
 *   2. reopening a Closed incident drops a stale Approved closure sign-off
 *      (applyReopenApprovalReset);
 *   3. only changed columns are written;
 *   4. every changed field is recorded in incident change history.
 */

import { Transaction } from "sequelize";
import { sequelize } from "../database/db";
import { AIIncidentManagementModel } from "../domain.layer/models/incidentManagement/incidemtManagement.model";
import { getIncidentByIdQuery, updateIncidentByIdQuery } from "../utils/incidentManagement.utils";
import { applyReopenApprovalReset } from "../utils/validations/incidentManagementValidation.utils";
import { trackEntityChanges, recordMultipleFieldChanges } from "../utils/changeHistory.base.utils";

export interface UpdateIncidentOptions {
  /** Run inside the caller's transaction; the caller commits or rolls back. */
  transaction?: Transaction;
  /**
   * Record history as a system change (null actor, changed_by_system = true),
   * for integrations and jobs rather than a person.
   */
  changedBySystem?: boolean;
}

/**
 * Applies `updates` to incident `incidentId`. Returns the updated incident,
 * or null when it does not exist in the organization.
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

    const existingData = existing.toSafeJSON();
    const effective = applyReopenApprovalReset(existingData, updates);

    const saved = await updateIncidentByIdQuery(
      incidentId,
      effective,
      organizationId,
      transaction,
      existing,
    );

    if (userId || options.changedBySystem) {
      const changes = await trackEntityChanges("incident", existingData, effective);
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

    if (ownsTransaction) await transaction.commit();
    return saved;
  } catch (error) {
    if (ownsTransaction) await transaction.rollback();
    throw error;
  }
}
