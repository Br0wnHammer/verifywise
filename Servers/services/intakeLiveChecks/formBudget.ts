// Servers/services/intakeLiveChecks/formBudget.ts
// Per-form hourly caps on the public AI endpoints, counted in Redis so they
// hold across replicas and restarts. They are the real ceiling on a customer's
// LLM key, so every failure refuses: a Redis error or a Redis that does not
// answer within REDIS_TIMEOUT_MS counts as over the limit.
import redisClient from "../../database/redis";
import logger from "../../utils/logger/fileLogger";

export type FormBudgetEndpoint = "checks" | "prefill";

/** Calls per form per hour, across all visitors. */
export const FORM_BUDGET_PER_HOUR: Readonly<Record<FormBudgetEndpoint, number>> = {
  checks: 300,
  prefill: 20,
};

/**
 * The shared client sets maxRetriesPerRequest: null, so a command sent while
 * Redis is down waits forever. Each call is raced against this limit instead.
 */
export const REDIS_TIMEOUT_MS = 300;

const HOUR_SECONDS = 3600;

/** `intake:livechecks:<endpoint>:<formId>:<yyyymmddhh>`, the hour in UTC. */
export function formBudgetKey(formId: number, endpoint: FormBudgetEndpoint, now: Date): string {
  const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
  return `intake:livechecks:${endpoint}:${formId}:${hour}`;
}

const TIMED_OUT = Symbol("timed out");

async function withinRedisTimeout<T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), REDIS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Counts one call against the form's hourly budget. True while the count is
 * within `limit`; false when it is over, when Redis errors, or when Redis does
 * not answer in time.
 */
export async function consumeFormBudget(
  formId: number,
  endpoint: FormBudgetEndpoint,
  limit: number,
  now: Date = new Date(),
): Promise<boolean> {
  const key = formBudgetKey(formId, endpoint, now);
  try {
    const count = await withinRedisTimeout(redisClient.incr(key));
    if (count === TIMED_OUT) {
      logger.warn(
        `Intake ${endpoint} budget: Redis did not answer, refusing AI for form ${formId}`,
      );
      return false;
    }
    if (count === 1) {
      // The hour is in the key, so a missed expiry only leaves a stale key.
      const expired = await withinRedisTimeout(redisClient.expire(key, HOUR_SECONDS)).catch(
        () => TIMED_OUT,
      );
      if (expired === TIMED_OUT) logger.warn(`Intake ${endpoint} budget: expiry not confirmed`);
    }
    return count <= limit;
  } catch (error) {
    logger.warn(
      `Intake ${endpoint} budget: Redis error, refusing AI for form ${formId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
