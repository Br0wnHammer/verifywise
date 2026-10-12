"use strict";

/**
 * Jira Assets sync history: `links_removed`.
 *
 * Counts link rows a manual sync removed because their object was gone from
 * Jira and they had no project (objects_deleted only counts projects actually
 * deleted). A separate migration from 20261012003957 so databases that already
 * ran the heartbeat migration still get the column.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE verifywise.jira_assets_sync_history
         ADD COLUMN IF NOT EXISTS links_removed INTEGER NOT NULL DEFAULT 0
         CONSTRAINT jira_assets_sync_history_links_removed_nonneg_chk CHECK (links_removed >= 0);`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE verifywise.jira_assets_sync_history DROP COLUMN IF EXISTS links_removed;`,
    );
  },
};
