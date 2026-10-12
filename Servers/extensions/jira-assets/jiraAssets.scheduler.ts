import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { getAllOrganizationsQuery } from "../../utils/organization.utils";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { isIntervalElapsed, latestDate } from "../scheduledSync.utils";
import { JiraSyncInProgressError, syncObjects } from "./jiraAssets.service";

/**
 * Automatic Jira Assets sync.
 *
 * The repeatable `jira_assets_scheduled_sync_check` job (automation-actions
 * queue, every 5 minutes) calls `runJiraAssetsScheduledSyncAllOrgs`. For each
 * organization it loads one row of sync state and asks the pure
 * `evaluateScheduledSync` whether a sync is due. Due orgs get
 * `syncObjects(org, null, "scheduled")`; the service's `claimSyncRun` guard
 * makes an org that is already syncing (manual or scheduled) a no-op.
 *
 * Orgs are processed one at a time and independently: an error in one is
 * logged and the loop moves on.
 */

const fileName = "jiraAssets.scheduler.ts";

/** Everything the due check needs for one organization. */
export interface JiraScheduledSyncState {
  extension_enabled: boolean;
  has_config: boolean;
  sync_enabled: boolean;
  sync_interval_hours: number | null;
  selected_object_type_id: string | null;
  has_use_cases: boolean;
  /** Finish time of the last sync (config.last_sync_at, set on success and failure). */
  last_sync_at: Date | string | null;
  /** Start time of the most recent history row, manual or scheduled. */
  last_started_at: Date | string | null;
}

export type ScheduledSyncDecision =
  | "due"
  | "extension_disabled"
  | "no_config"
  | "sync_disabled"
  | "no_object_type"
  | "no_use_cases"
  | "not_due";

/**
 * Pure due check. A sync is due when the extension is enabled, a config with
 * automatic sync and an object type exists, at least one use case has been
 * imported, and `sync_interval_hours` have passed since the later of the last
 * sync start and finish. Never synced counts as due.
 *
 * The "at least one use case" rule matches the panel, which disables
 * **Sync now** until something is imported. Without it, switching automatic
 * sync on before the first import would pull in every object of the type.
 */
export function evaluateScheduledSync(
  state: JiraScheduledSyncState,
  now: Date,
): ScheduledSyncDecision {
  if (!state.extension_enabled) return "extension_disabled";
  if (!state.has_config) return "no_config";
  if (!state.sync_enabled) return "sync_disabled";
  if (!state.selected_object_type_id) return "no_object_type";
  if (!state.has_use_cases) return "no_use_cases";
  const lastRunAt = latestDate(state.last_sync_at, state.last_started_at);
  return isIntervalElapsed(lastRunAt, Number(state.sync_interval_hours), now) ? "due" : "not_due";
}

/**
 * Load the sync state for one organization. Every table is filtered on
 * organization_id. Returns null when the org never enabled the extension or
 * has no Jira config, which the caller treats as "skip".
 */
export async function getScheduledSyncState(
  organizationId: number,
): Promise<JiraScheduledSyncState | null> {
  const rows = (await sequelize.query(
    `SELECT COALESCE(ee.enabled, FALSE) AS extension_enabled,
            TRUE AS has_config,
            c.sync_enabled,
            c.sync_interval_hours,
            c.selected_object_type_id,
            c.last_sync_at,
            (SELECT MAX(h.started_at)
               FROM jira_assets_sync_history h
              WHERE h.organization_id = :organizationId) AS last_started_at,
            EXISTS (SELECT 1
                      FROM jira_assets_use_cases u
                     WHERE u.organization_id = :organizationId) AS has_use_cases
       FROM jira_assets_config c
       JOIN extensions e ON e.key = 'jira-assets'
  LEFT JOIN extension_enablements ee
         ON ee.extension_id = e.id AND ee.organization_id = :organizationId
      WHERE c.organization_id = :organizationId
      LIMIT 1;`,
    { replacements: { organizationId }, type: QueryTypes.SELECT },
  )) as JiraScheduledSyncState[];
  return rows[0] ?? null;
}

export interface JiraScheduledSyncSummary {
  checked: number;
  synced: number;
  failed: number;
  skippedRunning: number;
}

/** Entry point for the `jira_assets_scheduled_sync_check` job. */
export async function runJiraAssetsScheduledSyncAllOrgs(
  now: Date = new Date(),
): Promise<JiraScheduledSyncSummary> {
  const summary: JiraScheduledSyncSummary = {
    checked: 0,
    synced: 0,
    failed: 0,
    skippedRunning: 0,
  };
  const organizations = await getAllOrganizationsQuery();

  for (const org of organizations) {
    const organizationId = org.id;
    if (organizationId === undefined || organizationId === null) continue;
    summary.checked++;
    try {
      const state = await getScheduledSyncState(organizationId);
      if (!state || evaluateScheduledSync(state, now) !== "due") continue;

      const result = await syncObjects(organizationId, null, "scheduled");
      if (result.success) {
        summary.synced++;
        logger.info(
          `Jira Assets scheduled sync org ${organizationId}: fetched=${result.objectsFetched} created=${result.objectsCreated} updated=${result.objectsUpdated} deleted=${result.objectsDeleted}`,
        );
      } else {
        // syncObjects already wrote the failure to the history row and config.
        summary.failed++;
        logStructured(
          "error",
          `Jira Assets scheduled sync failed for org ${organizationId}: ${result.status}`,
          "runJiraAssetsScheduledSyncAllOrgs",
          fileName,
        );
      }
    } catch (error) {
      if (error instanceof JiraSyncInProgressError) {
        summary.skippedRunning++;
        logger.info(`Jira Assets scheduled sync org ${organizationId}: skipped, sync running`);
        continue;
      }
      summary.failed++;
      logStructured(
        "error",
        `Jira Assets scheduled sync errored for org ${organizationId}`,
        "runJiraAssetsScheduledSyncAllOrgs",
        fileName,
      );
      logger.error(`❌ Jira Assets scheduled sync failed for org ${organizationId}:`, error);
    }
  }

  return summary;
}
