import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { isIntervalElapsed, latestDate } from "../scheduledSync.utils";
import { JiraSyncInProgressError, SYNC_STALE_AFTER_MS, syncObjects } from "./jiraAssets.service";

/**
 * Automatic Jira Assets sync.
 *
 * The repeatable `jira_assets_scheduled_sync_check` job (automation-actions
 * queue, every 5 minutes) calls `runJiraAssetsScheduledSyncAllOrgs`. One query
 * (`getScheduledSyncCandidates`) returns every org that could be due — config
 * with sync switched on and the extension enabled — with its last-run and
 * heartbeat info, and the pure `evaluateScheduledSync` decides per org.
 *
 * Due orgs get `syncObjects(org, null, "scheduled")`, which is refresh-only:
 * it updates already-linked use cases and never creates or deletes. The
 * service's `claimSyncRun` guard makes an org that is already syncing a no-op.
 * Orgs are processed one at a time and independently: an error in one is
 * logged and the loop moves on.
 */

const fileName = "jiraAssets.scheduler.ts";

/** One candidate org and everything the due check needs. */
export interface JiraScheduledSyncState {
  organization_id: number;
  sync_enabled: boolean;
  sync_interval_hours: number | null;
  selected_object_type_id: string | null;
  has_use_cases: boolean;
  /** Finish time of the last sync (config.last_sync_at, set on success and failure). */
  last_sync_at: Date | string | null;
  /** Start time of the most recent manual or scheduled sync (imports excluded). */
  last_started_at: Date | string | null;
  /** Latest heartbeat (else start) of a run still marked `started`, if any. */
  running_heartbeat_at: Date | string | null;
}

export type ScheduledSyncDecision =
  "due" | "sync_disabled" | "no_object_type" | "no_use_cases" | "running" | "not_due";

/**
 * Pure due check. A sync is due when automatic sync is on, an object type is
 * selected, at least one use case is linked (a scheduled run only refreshes
 * links, so with none there is nothing to do), no run is alive (heartbeat
 * within SYNC_STALE_AFTER_MS), and `sync_interval_hours` have passed since the
 * later of the last sync start and finish. Never synced counts as due. A run
 * whose heartbeat is stale is not "running": the claim closes it as abandoned.
 */
export function evaluateScheduledSync(
  state: JiraScheduledSyncState,
  now: Date,
): ScheduledSyncDecision {
  if (!state.sync_enabled) return "sync_disabled";
  if (!state.selected_object_type_id) return "no_object_type";
  if (!state.has_use_cases) return "no_use_cases";
  const heartbeat = latestDate(state.running_heartbeat_at);
  if (heartbeat && now.getTime() - heartbeat.getTime() < SYNC_STALE_AFTER_MS) return "running";
  const lastRunAt = latestDate(state.last_sync_at, state.last_started_at);
  return isIntervalElapsed(lastRunAt, Number(state.sync_interval_hours), now) ? "due" : "not_due";
}

/**
 * Every org whose Jira Assets extension is enabled and whose config has
 * automatic sync switched on. This is a system job's discovery query, so it
 * spans organizations by design; every subquery is correlated on the outer
 * row's organization_id, and each sync it triggers is scoped to one org.
 */
export async function getScheduledSyncCandidates(): Promise<JiraScheduledSyncState[]> {
  return (await sequelize.query(
    `SELECT c.organization_id,
            c.sync_enabled,
            c.sync_interval_hours,
            c.selected_object_type_id,
            c.last_sync_at,
            (SELECT MAX(h.started_at)
               FROM jira_assets_sync_history h
              WHERE h.organization_id = c.organization_id
                AND h.sync_type IN ('manual', 'scheduled')) AS last_started_at,
            (SELECT MAX(COALESCE(h.heartbeat_at, h.started_at))
               FROM jira_assets_sync_history h
              WHERE h.organization_id = c.organization_id
                AND h.status = 'started') AS running_heartbeat_at,
            EXISTS (SELECT 1
                      FROM jira_assets_use_cases u
                     WHERE u.organization_id = c.organization_id) AS has_use_cases
       FROM jira_assets_config c
       JOIN extensions e ON e.key = 'jira-assets'
       JOIN extension_enablements ee
         ON ee.extension_id = e.id
        AND ee.organization_id = c.organization_id
        AND ee.enabled = TRUE
      WHERE c.sync_enabled = TRUE
      ORDER BY c.organization_id;`,
    { type: QueryTypes.SELECT },
  )) as JiraScheduledSyncState[];
}

export interface JiraScheduledSyncSummary {
  candidates: number;
  synced: number;
  failed: number;
  skippedRunning: number;
}

/** Entry point for the `jira_assets_scheduled_sync_check` job. */
export async function runJiraAssetsScheduledSyncAllOrgs(
  now: Date = new Date(),
): Promise<JiraScheduledSyncSummary> {
  const candidates = await getScheduledSyncCandidates();
  const summary: JiraScheduledSyncSummary = {
    candidates: candidates.length,
    synced: 0,
    failed: 0,
    skippedRunning: 0,
  };

  for (const state of candidates) {
    const organizationId = Number(state.organization_id);
    if (!Number.isInteger(organizationId) || organizationId <= 0) continue;
    try {
      const decision = evaluateScheduledSync(state, now);
      if (decision === "running") {
        summary.skippedRunning++;
        continue;
      }
      if (decision !== "due") continue;

      const result = await syncObjects(organizationId, null, "scheduled");
      if (result.success) {
        summary.synced++;
        logger.info(
          `Jira Assets scheduled sync org ${organizationId}: fetched=${result.objectsFetched} updated=${result.objectsUpdated} missingInJira=${result.objectsMissingInJira}`,
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
