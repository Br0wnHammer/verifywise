import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import logger, { logStructured } from "../../utils/logger/fileLogger";
import { sqlIntervalElapsed } from "../scheduledSync.utils";
import { SQL_RUN_IS_LIVE, startScheduledSync } from "./jiraAssets.service";

/**
 * Automatic Jira Assets sync.
 *
 * The repeatable `jira_assets_scheduled_sync_check` job (automation-actions
 * queue, every 5 minutes) calls `runJiraAssetsScheduledSyncAllOrgs`. One query
 * (`getScheduledSyncCandidates`) returns every org that could be due — config
 * with sync switched on and the extension enabled — with `is_due` and
 * `running_is_live` computed in SQL against NOW(), and the pure
 * `evaluateScheduledSync` turns those flags into a decision.
 *
 * For each due org the check only queues a job (`startScheduledSync` → one
 * `jira_assets_sync_run` job per org), so it returns quickly and orgs sync
 * independently in the worker, which claims the run at pickup. The job id is
 * fixed per org, so overlapping ticks cannot queue two: the second finds the
 * first waiting and the org is skipped. A scheduled run is refresh-only: it
 * updates already-linked use cases, flags missing ones, and never creates or
 * deletes. An error for one org is logged and the loop moves on.
 */

const fileName = "jiraAssets.scheduler.ts";

/** One candidate org, with every time-based decision already made in SQL. */
export interface JiraScheduledSyncState {
  organization_id: number;
  has_object_type: boolean;
  has_use_cases: boolean;
  /** A sync or import has a heartbeat inside the stale window. */
  running_is_live: boolean;
  /**
   * sync_interval_hours have passed since the later of last_sync_at and the
   * newest manual/scheduled started_at (imports excluded); true if neither.
   */
  is_due: boolean;
}

export type ScheduledSyncDecision =
  "due" | "no_object_type" | "no_use_cases" | "running" | "not_due";

/**
 * Pure decision from the SQL flags. Order matters only for reporting: an org
 * with nothing to refresh is "no_use_cases" whether or not it is due.
 */
export function evaluateScheduledSync(state: JiraScheduledSyncState): ScheduledSyncDecision {
  if (!state.has_object_type) return "no_object_type";
  if (!state.has_use_cases) return "no_use_cases";
  if (state.running_is_live) return "running";
  return state.is_due ? "due" : "not_due";
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
            (c.selected_object_type_id IS NOT NULL
               AND c.selected_object_type_id <> '') AS has_object_type,
            EXISTS (SELECT 1
                      FROM jira_assets_use_cases u
                     WHERE u.organization_id = c.organization_id) AS has_use_cases,
            EXISTS (SELECT 1
                      FROM jira_assets_sync_history h
                     WHERE h.organization_id = c.organization_id
                       AND h.status = 'started'
                       AND ${SQL_RUN_IS_LIVE}) AS running_is_live,
            ${sqlIntervalElapsed("lr.last_run", "c.sync_interval_hours")} AS is_due
       FROM jira_assets_config c
       -- The later of the last finish and the newest manual/scheduled start
       -- (imports excluded). GREATEST ignores NULLs.
       CROSS JOIN LATERAL (
         SELECT GREATEST(
                  c.last_sync_at,
                  (SELECT MAX(h.started_at)
                     FROM jira_assets_sync_history h
                    WHERE h.organization_id = c.organization_id
                      AND h.sync_type IN ('manual', 'scheduled')
                      -- Claimed runs only: a manual sync the worker skipped
                      -- (no token) must not delay the schedule.
                      AND h.run_token IS NOT NULL)) AS last_run
       ) lr
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
  queued: number;
  failed: number;
  skippedRunning: number;
}

/** Entry point for the `jira_assets_scheduled_sync_check` job. */
export async function runJiraAssetsScheduledSyncAllOrgs(): Promise<JiraScheduledSyncSummary> {
  const candidates = await getScheduledSyncCandidates();
  const summary: JiraScheduledSyncSummary = {
    candidates: candidates.length,
    queued: 0,
    failed: 0,
    skippedRunning: 0,
  };

  for (const state of candidates) {
    const organizationId = Number(state.organization_id);
    if (!Number.isInteger(organizationId) || organizationId <= 0) continue;
    const decision = evaluateScheduledSync(state);
    if (decision === "running") {
      summary.skippedRunning++;
      continue;
    }
    if (decision !== "due") continue;
    try {
      const { jobId, queued } = await startScheduledSync(organizationId);
      if (!queued) {
        summary.skippedRunning++;
        continue;
      }
      summary.queued++;
      logger.info(`Jira Assets scheduled sync org ${organizationId}: queued job ${jobId}`);
    } catch (error) {
      summary.failed++;
      logStructured(
        "error",
        `Jira Assets scheduled sync could not be queued for org ${organizationId}`,
        "runJiraAssetsScheduledSyncAllOrgs",
        fileName,
      );
      logger.error(`❌ Jira Assets scheduled sync queue failed for org ${organizationId}:`, error);
    }
  }

  return summary;
}
