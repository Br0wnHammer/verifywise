jest.setTimeout(60000);

import { QueryTypes } from "sequelize";
import { sequelize } from "../../../database/db";
import { cleanupDatabase, seedTwoOrgsAndUsers } from "../helpers";

/**
 * Sync engine tables (extension_sync_runs, extension_sync_settings) and the
 * generic /api/extensions/:key/runs… and /:key/schedule routes. The CRUD
 * matrix is id-based and these routes are keyed by the extension key, so this
 * file covers them by hand.
 */

async function seedOwnerSync(orgId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO extension_sync_settings
       (organization_id, extension_key, enabled, interval_hours, consecutive_failures, failing_since)
     VALUES (:orgId, 'jira-assets', TRUE, 6, 2, now() - interval '1 hour');`,
    { replacements: { orgId } },
  );
  await sequelize.query(
    `INSERT INTO extension_sync_runs
       (organization_id, extension_key, kind, status, counts, message, run_token,
        started_at, completed_at)
     VALUES (:orgId, 'jira-assets', 'manual', 'completed', jsonb_build_object('fetched', 3),
             'owner run', 'owner-token', now() - interval '5 minutes', now());`,
    { replacements: { orgId } },
  );
}

async function count(table: string, orgId: number): Promise<number> {
  const [row] = await sequelize.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = :orgId`,
    { replacements: { orgId }, type: QueryTypes.SELECT },
  );
  return Number(row.n);
}

describe("extension sync tables tenant isolation", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  it("does not return org A rows when reading as org B", async () => {
    const { orgA, orgB } = await seedTwoOrgsAndUsers();
    await seedOwnerSync(orgA);

    for (const table of ["extension_sync_settings", "extension_sync_runs"]) {
      expect(await count(table, orgA)).toBe(1);
      expect(await count(table, orgB)).toBe(0);
    }
  });
});
