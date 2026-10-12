"use strict";

/**
 * Jira Assets links can only point at a project in their own organization.
 *
 * jira_assets_use_cases.project_id had a single-column FK to projects(id), so
 * nothing stopped a link in one organization from referencing another
 * organization's project. The app only ever creates a link together with its
 * project, in the same organization and transaction, and never changes
 * project_id afterwards, but the database did not enforce it.
 *
 * Deploy: run this with the worker stopped or idle (no Jira Assets sync
 * running), as for any migration that ships with an API and worker release.
 *
 * Locks (taken up front, projects first, with a 10 s lock_timeout so the
 * migration fails fast instead of queueing behind live traffic):
 * - projects: SHARE ROW EXCLUSIVE, the strongest mode up() needs there
 *   (CREATE UNIQUE INDEX takes SHARE, adding the FK takes SHARE ROW
 *   EXCLUSIVE, validating it takes ROW SHARE). Reads of projects, including
 *   SELECT ... FOR UPDATE/SHARE, are not blocked; writes wait.
 * - jira_assets_use_cases: ACCESS EXCLUSIVE (dropping its old index needs it).
 * The old single-column FK is kept: dropping any FK from this table to
 * projects takes ACCESS EXCLUSIVE on projects (it removes triggers there),
 * which up() avoids. It is redundant with the composite FK (which implies
 * it) and harmless; both cascade on delete.
 *
 * up(), in one transaction:
 * 1. Links whose project_id is set but has no project in the link's own
 *    organization (missing, or another organization's) are copied, by named
 *    columns, into verifywise.jira_assets_use_cases_fk_cleanup_backup (plus
 *    cleaned_at) and deleted. No project is touched. The Jira object is then
 *    no longer linked, so it can be imported again. The count is logged.
 *    (They are deleted, not NULLed: a NULLed link whose object Jira still
 *    returns would have its missing flag cleared by every sync, never reach
 *    the panel's removal list, and block a re-import.) The backup's
 *    organization_id references organizations ON DELETE CASCADE, so a
 *    deleted organization's backup rows go with it.
 * 2. A unique index on projects (id, organization_id) as the composite FK
 *    target, unless an equivalent one already exists (then that one is
 *    used). This migration's own index is named
 *    projects_id_org_for_jira_link_fk_key, and down() drops only that name.
 * 3. FOREIGN KEY (project_id, organization_id)
 *      REFERENCES projects (id, organization_id) ON DELETE CASCADE
 *    is added NOT VALID, then validated (MATCH SIMPLE, the default, so a NULL
 *    project_id still passes), with an index on (project_id, organization_id);
 *    the old index on project_id is then redundant and dropped.
 *
 * down() drops the composite FK (this does take ACCESS EXCLUSIVE on projects,
 * briefly; a rollback is rare), its index and this migration's unique index,
 * recreates the old index, and puts the backed-up links back where the
 * single-column FK allows it (organization and project still exist; ON
 * CONFLICT DO NOTHING). Restored rows are removed from the backup; the backup
 * table is dropped only when nothing is left in it, otherwise it is kept and
 * the remaining count is logged.
 */

const TABLE = "verifywise.jira_assets_use_cases";
const BACKUP = "verifywise.jira_assets_use_cases_fk_cleanup_backup";
const NEW_FK = "jira_assets_use_cases_project_org_fkey";
const OWN_UNIQUE = "projects_id_org_for_jira_link_fk_key";
const NEW_INDEX = "idx_jira_use_cases_project_org";
const OLD_INDEX = "idx_jira_use_cases_project_id";
const LOG = "[jira-assets-link-same-org-fk]";

/** The link columns this migration backs up and restores, in order. */
const LINK_COLUMNS = [
  "id",
  "organization_id",
  "jira_object_id",
  "project_id",
  "data",
  "last_synced_at",
  "sync_status",
  "created_at",
  "updated_at",
  "missing_in_jira_since",
];
const COLUMN_LIST = LINK_COLUMNS.map((c) => `"${c}"`).join(", ");

async function columnsOf(queryInterface, table, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'verifywise' AND table_name = :table
      ORDER BY ordinal_position;`,
    { replacements: { table }, transaction },
  );
  return rows.map((r) => r.column_name);
}

async function setLockTimeout(queryInterface, transaction) {
  await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '10s';`, { transaction });
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await setLockTimeout(queryInterface, transaction);
      await q(`LOCK TABLE verifywise.projects IN SHARE ROW EXCLUSIVE MODE;`);
      await q(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);

      // The live table must have exactly the columns this backup covers, or
      // the backup would lose data.
      const live = await columnsOf(queryInterface, "jira_assets_use_cases", transaction);
      if (live.join(",") !== LINK_COLUMNS.join(",")) {
        throw new Error(
          `${LOG} jira_assets_use_cases has columns [${live.join(", ")}], expected [${LINK_COLUMNS.join(", ")}]; update this migration's backup before running it.`,
        );
      }

      // 1. Back up and delete links whose project is not in their organization.
      await q(
        `CREATE TABLE IF NOT EXISTS ${BACKUP} (
           id                    INTEGER PRIMARY KEY,
           organization_id       INTEGER NOT NULL
                                   REFERENCES verifywise.organizations(id) ON DELETE CASCADE,
           jira_object_id        VARCHAR(100) NOT NULL,
           project_id            INTEGER,
           data                  JSONB NOT NULL,
           last_synced_at        TIMESTAMP,
           sync_status           VARCHAR(20) NOT NULL,
           created_at            TIMESTAMP NOT NULL,
           updated_at            TIMESTAMP NOT NULL,
           missing_in_jira_since TIMESTAMP,
           cleaned_at            TIMESTAMPTZ NOT NULL DEFAULT now()
         );`,
      );
      const backupColumns = await columnsOf(
        queryInterface,
        "jira_assets_use_cases_fk_cleanup_backup",
        transaction,
      );
      if (backupColumns.join(",") !== [...LINK_COLUMNS, "cleaned_at"].join(",")) {
        throw new Error(
          `${LOG} ${BACKUP} already exists with columns [${backupColumns.join(", ")}], not the expected [${[...LINK_COLUMNS, "cleaned_at"].join(", ")}]; inspect it and drop or rename it before running this migration.`,
        );
      }
      const [moved] = await q(
        `WITH removed AS (
           DELETE FROM ${TABLE} j
            WHERE j.project_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM verifywise.projects p
                 WHERE p.id = j.project_id AND p.organization_id = j.organization_id
              )
            RETURNING ${LINK_COLUMNS.map((c) => `j."${c}"`).join(", ")}
         ), backed_up AS (
           INSERT INTO ${BACKUP} (${COLUMN_LIST})
           SELECT ${COLUMN_LIST} FROM removed
           RETURNING 1
         )
         SELECT COUNT(*)::int AS count FROM backed_up;`,
      );
      console.log(
        `${LOG} deleted ${moved[0]?.count ?? 0} link(s) whose project is not in their organization; copies kept in ${BACKUP}`,
      );

      // 2. The composite FK target, unless an equivalent one already exists:
      // a valid, immediate, unique, non-partial, non-expression index whose
      // key columns (INCLUDE columns excluded) are exactly id, organization_id.
      const [equivalent] = await q(
        `SELECT 1
           FROM pg_index i
          WHERE i.indrelid = 'verifywise.projects'::regclass
            AND i.indisunique AND i.indisvalid AND i.indimmediate
            AND i.indpred IS NULL AND i.indexprs IS NULL
            AND i.indnkeyatts = 2
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                   FROM unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) AS k(attnum)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
                = ARRAY['id', 'organization_id']
          LIMIT 1;`,
      );
      if (equivalent.length === 0) {
        await q(`CREATE UNIQUE INDEX ${OWN_UNIQUE} ON verifywise.projects (id, organization_id);`);
      }

      // 3. The composite FK, added NOT VALID and then validated.
      await q(
        `ALTER TABLE ${TABLE}
           ADD CONSTRAINT ${NEW_FK}
           FOREIGN KEY (project_id, organization_id)
           REFERENCES verifywise.projects (id, organization_id)
           ON DELETE CASCADE
           NOT VALID;`,
      );
      await q(`ALTER TABLE ${TABLE} VALIDATE CONSTRAINT ${NEW_FK};`);
      await q(
        `CREATE INDEX IF NOT EXISTS ${NEW_INDEX}
           ON ${TABLE} (project_id, organization_id)
           WHERE project_id IS NOT NULL;`,
      );
      await q(`DROP INDEX IF EXISTS verifywise.${OLD_INDEX};`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await setLockTimeout(queryInterface, transaction);
      // Dropping the composite FK removes its triggers on projects, which
      // needs ACCESS EXCLUSIVE there; take it up front, projects first.
      await q(`LOCK TABLE verifywise.projects, ${TABLE} IN ACCESS EXCLUSIVE MODE;`);

      await q(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${NEW_FK};`);
      await q(`DROP INDEX IF EXISTS verifywise.${NEW_INDEX};`);
      await q(`DROP INDEX IF EXISTS verifywise.${OWN_UNIQUE};`);
      await q(
        `CREATE INDEX IF NOT EXISTS ${OLD_INDEX}
           ON ${TABLE} (project_id)
           WHERE project_id IS NOT NULL;`,
      );

      const [present] = await q(`SELECT to_regclass('${BACKUP}') IS NOT NULL AS present;`);
      if (!present[0]?.present) return;

      // Put back what the single-column FK allows: the organization and the
      // project (if any) still exist; a conflicting link (e.g. re-imported
      // since) wins. Restored rows leave the backup.
      const [result] = await q(
        `WITH restored AS (
           INSERT INTO ${TABLE} (${COLUMN_LIST})
           SELECT ${COLUMN_LIST} FROM ${BACKUP} b
            WHERE EXISTS (SELECT 1 FROM verifywise.organizations o WHERE o.id = b.organization_id)
              AND (b.project_id IS NULL
                   OR EXISTS (SELECT 1 FROM verifywise.projects p WHERE p.id = b.project_id))
           ON CONFLICT DO NOTHING
           RETURNING id
         ), cleared AS (
           DELETE FROM ${BACKUP} b USING restored r WHERE b.id = r.id RETURNING 1
         )
         SELECT (SELECT COUNT(*)::int FROM cleared) AS restored,
                (SELECT COUNT(*)::int FROM ${BACKUP}) - (SELECT COUNT(*)::int FROM cleared)
                  AS remaining;`,
      );
      const restored = result[0]?.restored ?? 0;
      const remaining = result[0]?.remaining ?? 0;

      // Keep the id sequence ahead of every id, never moving it backwards.
      const [seq] = await q(`SELECT pg_get_serial_sequence('${TABLE}', 'id') AS name;`);
      if (seq[0]?.name) {
        await q(
          `SELECT setval('${seq[0].name}',
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${TABLE}),
                                  (SELECT last_value FROM ${seq[0].name})));`,
        );
      }

      if (remaining === 0) {
        await q(`DROP TABLE ${BACKUP};`);
        console.log(`${LOG} restored ${restored} backed-up link(s); backup table dropped`);
      } else {
        console.log(
          `${LOG} restored ${restored} backed-up link(s); ${remaining} kept in ${BACKUP} (their project no longer exists, or their Jira object was linked again)`,
        );
      }
    });
  },
};
