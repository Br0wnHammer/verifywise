/**
 * SQL building blocks for extensions that sync on a per-organization interval.
 *
 * Pattern (see docs/technical/infrastructure/extensions.md, "Scheduled sync"):
 * one repeatable BullMQ check job runs every few minutes, a single candidate
 * query decides in SQL which orgs are due, and each due org is synced on its
 * own. Every time comparison happens in Postgres against NOW(), so nothing
 * depends on how node-pg turns a TIMESTAMP-without-time-zone column into a JS
 * Date.
 *
 * The run-tracking columns (started_at, heartbeat_at, completed_at,
 * last_sync_at) are TIMESTAMP WITHOUT TIME ZONE holding UTC wall-clock time:
 * they are written with SQL_NOW_UTC, and Sequelize (default `timezone:
 * "+00:00"`) also serialises JS Dates as UTC and sets each session's TIME ZONE
 * to +00:00. SQL_NOW_UTC is explicit anyway, so the comparisons stay right
 * even if that session setting ever changes.
 *
 * Only pass trusted SQL expressions (column names) to these helpers — they are
 * interpolated, not bound.
 */

/** Current time as a UTC TIMESTAMP WITHOUT TIME ZONE. */
export const SQL_NOW_UTC = "(NOW() AT TIME ZONE 'UTC')";

function assertWholeNumber(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number`);
  }
}

/**
 * True when `intervalHoursExpr` hours have passed since `lastRunExpr`, or when
 * there has been no run (NULL). Use GREATEST(a, b) for "the later of" —
 * Postgres GREATEST ignores NULLs.
 */
export function sqlIntervalElapsed(lastRunExpr: string, intervalHoursExpr: string): string {
  return `(${lastRunExpr} IS NULL OR ${lastRunExpr} + make_interval(hours => ${intervalHoursExpr}) <= ${SQL_NOW_UTC})`;
}

/** True when `timestampExpr` is within the last `minutes` minutes. */
export function sqlWithinLastMinutes(timestampExpr: string, minutes: number): string {
  assertWholeNumber(minutes, "minutes");
  return `(${timestampExpr} >= ${SQL_NOW_UTC} - make_interval(mins => ${minutes}))`;
}
