"use strict";

/**
 * Intake: AI-assisted risk assessment storage.
 *
 * suggested_risks holds the suggested-risks block (status, items, counts) as
 * JSONB; notification_sent_at is the one-time claim for the "needs review"
 * email. Existing submissions keep notification_sent_at NULL: the backfill
 * never emails, so that is safe.
 *
 * New intake forms default to the EU AI Act risk step on. Existing forms are
 * not changed.
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`
        ALTER TABLE verifywise.intake_submissions
          ADD COLUMN IF NOT EXISTS suggested_risks JSONB NULL,
          ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ NULL;
      `);
      await run(`
        ALTER TABLE verifywise.intake_forms
          ALTER COLUMN eu_ai_act_risk_step_enabled SET DEFAULT true;
      `);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`
        ALTER TABLE verifywise.intake_forms
          ALTER COLUMN eu_ai_act_risk_step_enabled SET DEFAULT false;
      `);
      await run(`
        ALTER TABLE verifywise.intake_submissions
          DROP COLUMN IF EXISTS notification_sent_at,
          DROP COLUMN IF EXISTS suggested_risks;
      `);
    });
  },
};
