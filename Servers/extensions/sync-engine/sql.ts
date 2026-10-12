/**
 * Pure SQL fragments for the sync engine. No database import, so the
 * throwaway-Postgres check scripts can load this file with ts-node. Only
 * trusted expressions (column names, bind parameters) are interpolated;
 * sqlOwnsRunFragment validates its values before inlining them.
 */
import { STALE_AFTER_MINUTES } from "./types";

const ALIAS_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

function assertAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) throw new Error(`Invalid SQL alias "${alias}"`);
}

/** SQL: run row `alias` has a heartbeat (else start) inside the stale window. */
export function sqlRunIsLive(alias: string): string {
  assertAlias(alias);
  return `(COALESCE(${alias}.heartbeat_at, ${alias}.started_at) >= now() - make_interval(mins => ${STALE_AFTER_MINUTES}))`;
}

/** SQL: a live `started` run exists for extension `keyExpr` in org `orgExpr`. */
export function sqlLiveRunExists(keyExpr: string, orgExpr: string): string {
  return `EXISTS (SELECT 1 FROM extension_sync_runs live
                   WHERE live.organization_id = ${orgExpr} AND live.extension_key = ${keyExpr}
                     AND live.status = 'started' AND ${sqlRunIsLive("live")})`;
}

export interface OwnedRunRef {
  runId: number;
  orgId: number;
  token: string;
}

/**
 * SQL boolean: the run still owns its `started` row. FOR SHARE holds the row
 * until the statement's transaction ends, so a claim closing it as abandoned
 * must wait: writes guarded by this cannot land after the claim was lost.
 */
export function sqlOwnsRunFragment(run: OwnedRunRef, alias = "own"): string {
  assertAlias(alias);
  if (
    !Number.isInteger(run.runId) ||
    run.runId <= 0 ||
    !Number.isInteger(run.orgId) ||
    run.orgId <= 0 ||
    !TOKEN_PATTERN.test(run.token)
  ) {
    throw new Error("Invalid run reference");
  }
  return `EXISTS (SELECT 1 FROM extension_sync_runs ${alias}
                   WHERE ${alias}.id = ${run.runId} AND ${alias}.organization_id = ${run.orgId}
                     AND ${alias}.run_token = '${run.token}' AND ${alias}.status = 'started'
                   FOR SHARE)`;
}
