"use strict";

/**
 * One Shadow AI settings row per organization.
 *
 * Nothing created a shadow_ai_settings row for a new organization, so saving
 * settings (a plain UPDATE) silently changed nothing. Settings are now saved
 * with INSERT ... ON CONFLICT (organization_id), which needs a unique index.
 *
 * Before adding it, duplicate rows for the same organization are removed,
 * keeping the most recently updated one (highest id on a tie).
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        DELETE FROM verifywise.shadow_ai_settings s
        USING (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY organization_id
                   ORDER BY updated_at DESC NULLS LAST, id DESC
                 ) AS rn
          FROM verifywise.shadow_ai_settings
          WHERE organization_id IS NOT NULL
        ) ranked
        WHERE s.id = ranked.id AND ranked.rn > 1;
        `,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_ai_settings_organization_id
          ON verifywise.shadow_ai_settings (organization_id);
        `,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "DROP INDEX IF EXISTS verifywise.uq_shadow_ai_settings_organization_id;",
    );
  },
};
