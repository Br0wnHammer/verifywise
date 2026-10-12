/**
 * Shared helpers for extensions that sync on a per-organization interval.
 *
 * Pattern (see docs/technical/infrastructure/extensions.md, "Scheduled sync"):
 * one repeatable BullMQ check job on the `automation-actions` queue runs every
 * few minutes, walks every organization, and for each one decides — with a pure
 * function built on `isIntervalElapsed` — whether that org's sync is due. The
 * per-org decision lives with the extension; only the timing rule lives here.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Latest of the given timestamps, ignoring null/undefined/invalid values. */
export function latestDate(...dates: Array<Date | string | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of dates) {
    if (value === null || value === undefined) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

/**
 * True when `intervalHours` have passed since `lastRunAt`, or when there has
 * never been a run. A non-positive or non-finite interval is never due, so a
 * bad value cannot turn into a sync on every tick.
 */
export function isIntervalElapsed(
  lastRunAt: Date | null,
  intervalHours: number,
  now: Date,
): boolean {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return false;
  if (!lastRunAt) return true;
  return lastRunAt.getTime() + intervalHours * HOUR_MS <= now.getTime();
}
