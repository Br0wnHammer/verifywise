"use strict";

/**
 * Jira incidents: retry the VerifyWise remote link on the Jira issue.
 *
 * jira_incident_links.remote_link_pending is true while the issue still lacks
 * the link back to the incident (set at import when FRONTEND_URL is set,
 * cleared once Jira accepts the link). Each sync run retries pending links.
 * Existing rows default to false: their link was added, failed long ago, or
 * FRONTEND_URL was unset, and there is no record of which.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`
        ALTER TABLE verifywise.jira_incident_links
          ADD COLUMN IF NOT EXISTS remote_link_pending BOOLEAN NOT NULL DEFAULT false;
      `);
      await run(`
        CREATE INDEX IF NOT EXISTS jira_incident_links_remote_link_pending_idx
          ON verifywise.jira_incident_links (organization_id, id)
          WHERE remote_link_pending;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`DROP INDEX IF EXISTS verifywise.jira_incident_links_remote_link_pending_idx;`);
      await run(`
        ALTER TABLE verifywise.jira_incident_links DROP COLUMN IF EXISTS remote_link_pending;
      `);
    });
  },
};
