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
 * It takes ACCESS EXCLUSIVE locks on projects and jira_assets_use_cases up
 * front (projects first, the app's order) with a 10 s lock_timeout, so it
 * fails fast instead of queueing behind, or deadlocking with, live traffic.
 *
 * up(), in one transaction:
 * 1. Links whose project_id is set but has no project in the link's own
 *    organization (missing, or another organization's) are copied, all
 *    columns, into verifywise.jira_assets_use_cases_fk_cleanup_backup (plus
 *    cleaned_at) and deleted. No project is touched. The Jira object is then
 *    no longer linked, so it can be imported again. The count is logged.
 *    (They are deleted, not NULLed: a NULLed link whose object Jira still
 *    returns would have its missing flag cleared by every sync, never reach
 *    the panel's removal list, and block a re-import.)
 * 2. projects gets UNIQUE (id, organization_id) as the composite FK target,
 *    unless an equivalent unique index already exists (then that one is
 *    used). This migration's own constraint is named
 *    projects_id_org_for_jira_link_fk_key, and down() drops only that name.
 * 3. The single-column FK on project_id is replaced by
 *    FOREIGN KEY (project_id, organization_id)
 *      REFERENCES projects (id, organization_id) ON DELETE CASCADE
 *    (MATCH SIMPLE, the default, so a NULL project_id still passes), with an
 *    index on (project_id, organization_id); the old index on project_id is
 *    then redundant and dropped.
 *
 * down() takes the same locks, restores the single-column FK and the old
 * index, drops the composite FK, its index and this migration's unique
 * constraint, puts the backed-up links back (ON CONFLICT DO NOTHING; a link
 * whose project no longer exists at all cannot satisfy even the old FK and is
 * left out, counted in the log), and drops the backup table.
 */

const TABLE = "verifywise.jira_assets_use_cases";
const BACKUP = "verifywise.jira_assets_use_cases_fk_cleanup_backup";
const NEW_FK = "jira_assets_use_cases_project_org_fkey";
const OLD_FK = "jira_assets_use_cases_project_id_fkey";
const OWN_UNIQUE = "projects_id_org_for_jira_link_fk_key";
const NEW_INDEX = "idx_jira_use_cases_project_org";
const OLD_INDEX = "idx_jira_use_cases_project_id";

/**
 * Fail fast rather than wait, and take every lock the DDL below needs up
 * front, projects before links (the app's order), so nothing is upgraded
 * mid-migration.
 */
async function lockTables(queryInterface, transaction) {
  await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '10s';`, { transaction });
  await queryInterface.sequelize.query(
    `LOCK TABLE verifywise.projects, ${TABLE} IN ACCESS EXCLUSIVE MODE;`,
    { transaction },
  );
}

/** Names of the FKs on jira_assets_use_cases that reference projects. */
async function projectForeignKeys(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT c.conname
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = '${TABLE}'::regclass
        AND c.confrelid = 'verifywise.projects'::regclass;`,
    { transaction },
  );
  return rows.map((r) => r.conname);
}

async function dropProjectForeignKeys(queryInterface, transaction) {
  for (const name of await projectForeignKeys(queryInterface, transaction)) {
    await queryInterface.sequelize.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT "${name}";`, {
      transaction,
    });
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await lockTables(queryInterface, transaction);

      // 1. Back up and delete links whose project is not in their organization.
      await queryInterface.sequelize.query(
        `CREATE TABLE IF NOT EXISTS ${BACKUP} (LIKE ${TABLE});
         ALTER TABLE ${BACKUP}
           ADD COLUMN IF NOT EXISTS cleaned_at TIMESTAMPTZ DEFAULT now();`,
        { transaction },
      );
      const [moved] = await queryInterface.sequelize.query(
        `WITH removed AS (
           DELETE FROM ${TABLE} j
            WHERE j.project_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM verifywise.projects p
                 WHERE p.id = j.project_id AND p.organization_id = j.organization_id
              )
            RETURNING j.*
         ), backed_up AS (
           INSERT INTO ${BACKUP} SELECT removed.*, now() FROM removed RETURNING 1
         )
         SELECT COUNT(*)::int AS count FROM backed_up;`,
        { transaction },
      );
      console.log(
        `[jira-assets-link-same-org-fk] deleted ${moved[0]?.count ?? 0} link(s) whose project is not in their organization; copies kept in ${BACKUP}`,
      );

      // 2. The composite FK target, unless an equivalent one already exists.
      const [equivalent] = await queryInterface.sequelize.query(
        `SELECT 1
           FROM pg_index i
          WHERE i.indrelid = 'verifywise.projects'::regclass
            AND i.indisunique
            AND i.indpred IS NULL
            AND i.indexprs IS NULL
            AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                   FROM pg_attribute a
                  WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey))
                = ARRAY['id', 'organization_id']
          LIMIT 1;`,
        { transaction },
      );
      if (equivalent.length === 0) {
        await queryInterface.sequelize.query(
          `ALTER TABLE verifywise.projects
             ADD CONSTRAINT ${OWN_UNIQUE} UNIQUE (id, organization_id);`,
          { transaction },
        );
      }

      // 3. Replace the single-column FK with the composite one.
      await dropProjectForeignKeys(queryInterface, transaction);
      await queryInterface.sequelize.query(
        `ALTER TABLE ${TABLE}
           ADD CONSTRAINT ${NEW_FK}
           FOREIGN KEY (project_id, organization_id)
           REFERENCES verifywise.projects (id, organization_id)
           ON DELETE CASCADE;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS ${NEW_INDEX}
           ON ${TABLE} (project_id, organization_id)
           WHERE project_id IS NOT NULL;
         DROP INDEX IF EXISTS verifywise.${OLD_INDEX};`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await lockTables(queryInterface, transaction);

      // The single-column FK and its index first, so the restored rows are
      // checked against it.
      await dropProjectForeignKeys(queryInterface, transaction);
      await queryInterface.sequelize.query(
        `ALTER TABLE ${TABLE}
           ADD CONSTRAINT ${OLD_FK}
           FOREIGN KEY (project_id) REFERENCES verifywise.projects (id) ON DELETE CASCADE;
         CREATE INDEX IF NOT EXISTS ${OLD_INDEX}
           ON ${TABLE} (project_id)
           WHERE project_id IS NOT NULL;
         DROP INDEX IF EXISTS verifywise.${NEW_INDEX};
         ALTER TABLE verifywise.projects DROP CONSTRAINT IF EXISTS ${OWN_UNIQUE};`,
        { transaction },
      );

      // Put the backed-up links back where the old FK allows it.
      const [backup] = await queryInterface.sequelize.query(
        `SELECT to_regclass('${BACKUP}') IS NOT NULL AS present;`,
        { transaction },
      );
      if (backup[0]?.present) {
        const [columns] = await queryInterface.sequelize.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'verifywise' AND table_name = 'jira_assets_use_cases'
            ORDER BY ordinal_position;`,
          { transaction },
        );
        const list = columns.map((c) => `"${c.column_name}"`).join(", ");
        const [restored] = await queryInterface.sequelize.query(
          `WITH restored AS (
             INSERT INTO ${TABLE} (${list})
             SELECT ${list} FROM ${BACKUP} b
              WHERE b.project_id IS NULL
                 OR EXISTS (SELECT 1 FROM verifywise.projects p WHERE p.id = b.project_id)
             ON CONFLICT DO NOTHING
             RETURNING 1
           )
           SELECT (SELECT COUNT(*)::int FROM restored) AS restored,
                  (SELECT COUNT(*)::int FROM ${BACKUP}) AS backed_up;`,
          { transaction },
        );
        console.log(
          `[jira-assets-link-same-org-fk] restored ${restored[0]?.restored ?? 0} of ${restored[0]?.backed_up ?? 0} backed-up link(s)`,
        );
        // Keep the id sequence ahead of the restored ids.
        await queryInterface.sequelize.query(
          `SELECT setval(pg_get_serial_sequence('${TABLE}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${TABLE}), 1));`,
          { transaction },
        );
        await queryInterface.sequelize.query(`DROP TABLE ${BACKUP};`, { transaction });
      }
    });
  },
};
