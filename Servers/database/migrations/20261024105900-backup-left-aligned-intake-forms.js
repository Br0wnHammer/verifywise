"use strict";

/**
 * Keep a copy of every left-aligned intake form's design settings before
 * 20261024110000 centers them.
 *
 * That migration moves every saved "left" to "center", because the old default
 * cannot be told apart from a deliberate choice, and its down() has nothing to
 * restore. This one runs just before it (migrations run in name order) and
 * copies the rows it will change, so a form whose owner wants left back can be
 * restored without access to anything but this table:
 *
 *   UPDATE verifywise.intake_forms f
 *      SET design_settings = b.design_settings
 *     FROM verifywise.intake_forms_alignment_backup b
 *    WHERE f.id = b.form_id AND f.id = <form id>;
 *
 * Where 20261024110000 has already run (development, test), there is nothing
 * left-aligned to copy unless an owner picked left again since, and copying
 * that is harmless. A form is copied once; a later run keeps the first copy.
 */
const BACKUP = "verifywise.intake_forms_alignment_backup";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS ${BACKUP} (
          form_id INTEGER PRIMARY KEY,
          design_settings JSONB NOT NULL,
          backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        `,
        { transaction },
      );
      const [rows] = await queryInterface.sequelize.query(
        `
        WITH copied AS (
          INSERT INTO ${BACKUP} (form_id, design_settings)
          SELECT id, design_settings
            FROM verifywise.intake_forms
           WHERE design_settings->>'alignment' = 'left'
          ON CONFLICT (form_id) DO NOTHING
          RETURNING 1
        )
        SELECT COUNT(*)::int AS copied FROM copied;
        `,
        { transaction },
      );
      const copied = Number(rows?.[0]?.copied ?? 0);
      console.log(
        `[20261024105900] copied ${copied} left-aligned intake form(s) to ${BACKUP} before 20261024110000 centers them`,
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${BACKUP};`);
  },
};
