import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { getSyncProvider, statusKinds } from "./registry";
import { sqlLiveRunExists } from "./sql";

/** A live `started` run of this extension exists for the org. */
export async function hasLiveRun(key: string, orgId: number): Promise<boolean> {
  const rows = (await sequelize.query(`SELECT ${sqlLiveRunExists(":key", ":orgId")} AS live;`, {
    replacements: { key, orgId },
    type: QueryTypes.SELECT,
  })) as Array<{ live: boolean }>;
  return !!rows[0]?.live;
}

/** Id of the newest run of a status kind, so a client can tell when a newer one finishes. */
export async function latestStatusRunId(key: string, orgId: number): Promise<number | null> {
  const kinds = statusKinds(getSyncProvider(key));
  const rows = (await sequelize.query(
    `SELECT id FROM extension_sync_runs
      WHERE organization_id = :orgId AND extension_key = :key AND kind IN (:kinds)
      ORDER BY started_at DESC, id DESC
      LIMIT 1;`,
    { replacements: { orgId, key, kinds }, type: QueryTypes.SELECT },
  )) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}
