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
 * up(), in one transaction:
 * 1. Links whose project_id is set but has no project in the link's own
 *    organization (missing, or another organization's) get project_id = NULL.
 *    They are not deleted: the panel's "Links cleaned up" path removes such
 *    links on request. The number of rows changed is logged in one line.
 * 2. projects gets UNIQUE (id, organization_id) (a composite FK target; id is
 *    already the primary key, so no existing row can violate it).
 * 3. The single-column FK on project_id is replaced by
 *    FOREIGN KEY (project_id, organization_id)
 *      REFERENCES projects (id, organization_id) ON DELETE CASCADE
 *    (MATCH SIMPLE, the default, so a NULL project_id still passes), with an
 *    index on (project_id, organization_id).
 *
 * down() restores the single-column FK and drops the composite index and the
 * unique constraint. The project_ids set to NULL in step 1 cannot be
 * restored: they pointed at projects the link's organization did not own.
 */

const TABLE = "verifywise.jira_assets_use_cases";
const NEW_FK = "jira_assets_use_cases_project_org_fkey";
const OLD_FK = "jira_assets_use_cases_project_id_fkey";
const PROJECTS_UNIQUE = "projects_id_organization_id_key";
const NEW_INDEX = "idx_jira_use_cases_project_org";

/** Names of the FKs on jira_assets_use_cases that reference projects. */
async function projectForeignKeys(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT c.conname
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = 'verifywise.jira_assets_use_cases'::regclass
        AND c.confrelid = 'verifywise.projects'::regclass;`,
    { transaction },
  );
  return rows.map((r) => r.conname);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const [nullable] = await queryInterface.sequelize.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'verifywise' AND table_name = 'jira_assets_use_cases'
            AND column_name = 'project_id';`,
        { transaction },
      );
      if (nullable[0]?.is_nullable !== "YES") {
        throw new Error(
          "jira_assets_use_cases.project_id is NOT NULL; cross-organization links cannot be cleared to NULL. Stopping.",
        );
      }

      // 1. Clear links whose project is not in the link's organization.
      const [cleared] = await queryInterface.sequelize.query(
        `WITH cleared AS (
           UPDATE ${TABLE} j
              SET project_id = NULL, updated_at = NOW()
            WHERE j.project_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM verifywise.projects p
                 WHERE p.id = j.project_id AND p.organization_id = j.organization_id
              )
            RETURNING j.id
         )
         SELECT COUNT(*)::int AS count FROM cleared;`,
        { transaction },
      );
      console.log(
        `[jira-assets-link-same-org-fk] set project_id to NULL on ${cleared[0]?.count ?? 0} link(s) whose project is not in their organization`,
      );

      // 2. The composite FK target on projects.
      const [unique] = await queryInterface.sequelize.query(
        `SELECT 1 FROM pg_constraint
          WHERE conname = '${PROJECTS_UNIQUE}'
            AND conrelid = 'verifywise.projects'::regclass;`,
        { transaction },
      );
      if (unique.length === 0) {
        await queryInterface.sequelize.query(
          `ALTER TABLE verifywise.projects
             ADD CONSTRAINT ${PROJECTS_UNIQUE} UNIQUE (id, organization_id);`,
          { transaction },
        );
      }

      // 3. Replace the single-column FK with the composite one.
      for (const name of await projectForeignKeys(queryInterface, transaction)) {
        await queryInterface.sequelize.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT "${name}";`, {
          transaction,
        });
      }
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
           WHERE project_id IS NOT NULL;`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const name of await projectForeignKeys(queryInterface, transaction)) {
        await queryInterface.sequelize.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT "${name}";`, {
          transaction,
        });
      }
      await queryInterface.sequelize.query(
        `ALTER TABLE ${TABLE}
           ADD CONSTRAINT ${OLD_FK}
           FOREIGN KEY (project_id) REFERENCES verifywise.projects (id) ON DELETE CASCADE;`,
        { transaction },
      );
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS verifywise.${NEW_INDEX};`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE verifywise.projects DROP CONSTRAINT IF EXISTS ${PROJECTS_UNIQUE};`,
        { transaction },
      );
      // project_ids set to NULL by up() are not restored (see the header).
    });
  },
};
