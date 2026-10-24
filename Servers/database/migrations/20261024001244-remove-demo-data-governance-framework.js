"use strict";

/**
 * Remove the Data Governance framework (id 16) from demo data in every
 * organization.
 *
 * The demo seed used to attach it to the demo organization project, which put
 * a "Data Governance" card on the framework dashboard that people did not
 * understand. The seed no longer adds it; this clears it from demo data that
 * was created before.
 *
 * Only demo rows are touched: a projects_frameworks row flagged is_demo on a
 * demo project. An organization that added the framework to a real project
 * keeps it and its work.
 *
 * Same steps as removing the framework from a project in the app
 * (deleteFrameworkFromProject): delete the practices' file links, then the
 * projects_frameworks row, which cascades to data_governance_practices and
 * data_governance_practices__risks.
 *
 * Down is a no-op: the removed demo rows are not recorded. Re-creating the
 * demo data does not bring them back either, since the seed no longer adds
 * the framework.
 */
const DEMO_DATA_GOVERNANCE = `
  SELECT pf.id, pf.organization_id
    FROM verifywise.projects_frameworks pf
    JOIN verifywise.projects p
      ON p.id = pf.project_id AND p.organization_id = pf.organization_id
   WHERE pf.framework_id = 16
     AND pf.is_demo IS TRUE
     AND p.is_demo IS TRUE
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `DELETE FROM verifywise.file_entity_links fel
          USING verifywise.data_governance_practices dp, (${DEMO_DATA_GOVERNANCE}) demo
          WHERE dp.projects_frameworks_id = demo.id
            AND fel.organization_id = demo.organization_id
            AND fel.framework_type = 'data_governance'
            AND fel.entity_type = 'practice'
            AND fel.entity_id = dp.id;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `DELETE FROM verifywise.projects_frameworks pf
          USING (${DEMO_DATA_GOVERNANCE}) demo
          WHERE pf.id = demo.id;`,
        { transaction },
      );
    });
  },

  async down() {
    // Nothing to restore; see the header.
  },
};
