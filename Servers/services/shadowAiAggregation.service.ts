/**
 * Shadow AI Aggregation Service
 *
 * Business logic for scheduled aggregation jobs:
 * - Daily rollup: aggregate yesterday's raw events
 * - Monthly rollup: aggregate last month's daily rollups
 * - Purge old events: delete events older than 30 days
 * - Nightly risk scoring: recalculate all tool risk scores
 *
 * Called by BullMQ worker handlers.
 */

import { sequelize } from "../database/db";
import logger from "../utils/logger/fileLogger";
import { calculateRiskScoresForOrganization } from "./shadowAiRiskScoring.service";
import { getSettingsQuery } from "../utils/shadowAiConfig.utils";
import {
  deletedRowCount,
  recordRetentionRun,
  type RetentionRecordType,
} from "../utils/dataRetention.utils";

/** Record a cleanup run; a recording failure is logged and never breaks the cleanup. */
async function recordShadowAiRun(
  organizationId: number,
  recordType: RetentionRecordType,
  days: number,
  deletedCount: number,
  error?: unknown,
): Promise<void> {
  try {
    await recordRetentionRun({
      organizationId,
      recordType,
      cutoff: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      deletedCount,
      status: error === undefined ? "success" : "failed",
      error: error === undefined ? null : error instanceof Error ? error.message : String(error),
    });
  } catch (error) {
    logger.error(
      `❌ Recording ${recordType} retention run failed for organization ${organizationId}:`,
      error,
    );
  }
}

/**
 * Get all organization IDs that have shadow AI data.
 */
async function getAllOrganizationIds(): Promise<number[]> {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT organization_id
     FROM shadow_ai_events
     ORDER BY organization_id`,
  );

  return (rows as any[]).map((r) => r.organization_id);
}

/**
 * Daily rollup: Aggregate yesterday's raw events into daily rollups.
 * Runs at 1:00 AM daily.
 */
export async function runDailyRollup(): Promise<void> {
  const orgIds = await getAllOrganizationIds();
  logger.debug(`🔄 Running shadow AI daily rollup for ${orgIds.length} organizations`);

  for (const organizationId of orgIds) {
    try {
      await sequelize.query(
        `
        INSERT INTO shadow_ai_daily_rollups
          (organization_id, rollup_date, user_email, tool_id, department, total_events, post_events, blocked_events)
        SELECT
          :organizationId,
          DATE(event_timestamp) as rollup_date,
          user_email,
          detected_tool_id as tool_id,
          department,
          COUNT(*) as total_events,
          COUNT(CASE WHEN http_method = 'POST' THEN 1 END) as post_events,
          COUNT(CASE WHEN action = 'blocked' THEN 1 END) as blocked_events
        FROM shadow_ai_events
        WHERE organization_id = :organizationId
          AND DATE(event_timestamp) = CURRENT_DATE - INTERVAL '1 day'
        GROUP BY DATE(event_timestamp), user_email, detected_tool_id, department
        ON CONFLICT (organization_id, rollup_date, user_email, tool_id) DO UPDATE SET
          total_events = EXCLUDED.total_events,
          post_events = EXCLUDED.post_events,
          blocked_events = EXCLUDED.blocked_events
      `,
        { replacements: { organizationId } },
      );

      logger.debug(`✅ Daily rollup completed for organization ${organizationId}`);
    } catch (error) {
      logger.error(`❌ Daily rollup failed for organization ${organizationId}:`, error);
    }
  }
}

/**
 * Monthly rollup: Aggregate last month's daily rollups into monthly rollups.
 * Runs at 1:00 AM on the 1st of each month.
 */
export async function runMonthlyRollup(): Promise<void> {
  const orgIds = await getAllOrganizationIds();
  logger.debug(`🔄 Running shadow AI monthly rollup for ${orgIds.length} organizations`);

  for (const organizationId of orgIds) {
    try {
      await sequelize.query(
        `
        INSERT INTO shadow_ai_monthly_rollups
          (organization_id, rollup_month, tool_id, department, unique_users, total_events, post_events, blocked_events)
        SELECT
          :organizationId,
          DATE_TRUNC('month', rollup_date) as rollup_month,
          tool_id,
          department,
          COUNT(DISTINCT user_email) as unique_users,
          SUM(total_events) as total_events,
          SUM(post_events) as post_events,
          SUM(blocked_events) as blocked_events
        FROM shadow_ai_daily_rollups
        WHERE organization_id = :organizationId
          AND rollup_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
          AND rollup_date < DATE_TRUNC('month', CURRENT_DATE)
        GROUP BY DATE_TRUNC('month', rollup_date), tool_id, department
        ON CONFLICT (organization_id, rollup_month, tool_id, department) DO UPDATE SET
          unique_users = EXCLUDED.unique_users,
          total_events = EXCLUDED.total_events,
          post_events = EXCLUDED.post_events,
          blocked_events = EXCLUDED.blocked_events
      `,
        { replacements: { organizationId } },
      );

      logger.debug(`✅ Monthly rollup completed for organization ${organizationId}`);
    } catch (error) {
      logger.error(`❌ Monthly rollup failed for organization ${organizationId}:`, error);
    }
  }
}

/** The three Shadow AI cleanups. Table and column names come only from this list. */
const SHADOW_AI_PURGES: ReadonlyArray<{
  recordType: RetentionRecordType;
  setting:
    "retention_events_days" | "retention_daily_rollups_days" | "retention_alert_history_days";
  table: string;
  timestampColumn: string;
  label: string;
}> = [
  {
    recordType: "shadow_ai_events",
    setting: "retention_events_days",
    table: "shadow_ai_events",
    timestampColumn: "event_timestamp",
    label: "events",
  },
  {
    recordType: "shadow_ai_daily_rollups",
    setting: "retention_daily_rollups_days",
    table: "shadow_ai_daily_rollups",
    timestampColumn: "rollup_date",
    label: "daily rollups",
  },
  {
    recordType: "shadow_ai_alert_history",
    setting: "retention_alert_history_days",
    table: "shadow_ai_alert_history",
    timestampColumn: "fired_at",
    label: "alert records",
  },
];

/**
 * Purge old data based on per-organization retention settings.
 * Deletes raw events, daily rollups, and alert history older than configured days.
 * A value of 0 means keep data indefinitely (no purge).
 * Each cleanup records its own run; a failing one records a failed run and
 * the others still run.
 * Runs at 2:00 AM daily.
 */
export async function purgeOldEvents(): Promise<void> {
  const orgIds = await getAllOrganizationIds();
  logger.debug(`🔄 Running data retention cleanup for ${orgIds.length} organizations`);

  for (const organizationId of orgIds) {
    let settings: Awaited<ReturnType<typeof getSettingsQuery>>;
    try {
      settings = await getSettingsQuery(organizationId);
    } catch (error) {
      // Without the settings there are no periods, so no run to record.
      logger.error(`❌ Data retention cleanup failed for organization ${organizationId}:`, error);
      continue;
    }

    for (const purge of SHADOW_AI_PURGES) {
      const days = settings[purge.setting];
      if (!(days > 0)) continue;
      try {
        const [, meta] = await sequelize.query(
          `DELETE FROM ${purge.table}
           WHERE organization_id = :organizationId
             AND ${purge.timestampColumn} < NOW() - INTERVAL '1 day' * :days`,
          { replacements: { organizationId, days } },
        );
        const deleted = deletedRowCount(meta);
        await recordShadowAiRun(organizationId, purge.recordType, days, deleted);
        if (deleted > 0) {
          logger.debug(
            `✅ Purged ${deleted} ${purge.label} older than ${days}d for organization ${organizationId}`,
          );
        }
      } catch (error) {
        logger.error(
          `❌ Data retention cleanup failed for organization ${organizationId} (${purge.table}):`,
          error,
        );
        await recordShadowAiRun(organizationId, purge.recordType, days, 0, error);
      }
    }
  }
}

/**
 * Nightly risk scoring: Recalculate risk scores for all tools across all organizations.
 * Runs at 1:30 AM daily.
 */
export async function runNightlyRiskScoring(): Promise<void> {
  const orgIds = await getAllOrganizationIds();
  logger.debug(`🔄 Running nightly risk scoring for ${orgIds.length} organizations`);

  for (const organizationId of orgIds) {
    try {
      await calculateRiskScoresForOrganization(organizationId);
      logger.debug(`✅ Risk scoring completed for organization ${organizationId}`);
    } catch (error) {
      logger.error(`❌ Risk scoring failed for organization ${organizationId}:`, error);
    }
  }
}
