"use strict";

/**
 * Let the retention job delete audit_ledger rows, and only those: the
 * transaction must set verifywise.ledger_retention = 'on' and the row must be
 * covered by a checkpoint for its organization. The trigger
 * trg_audit_ledger_no_delete is unchanged; only the function it calls is.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION verifywise.audit_ledger_prevent_delete()
      RETURNS trigger LANGUAGE plpgsql AS $func$
      BEGIN
        -- Organization cascade (unchanged from 20260326204836).
        IF NOT EXISTS (SELECT 1 FROM verifywise.organizations WHERE id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        -- Retention job: flagged transaction, and only rows covered by a checkpoint.
        IF current_setting('verifywise.ledger_retention', true) = 'on'
           AND OLD.id <= (SELECT MAX(c.pruned_through_id)
                            FROM verifywise.audit_ledger_retention_checkpoints c
                           WHERE c.organization_id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'DELETE on audit_ledger is prohibited — append-only table';
      END;
      $func$;
    `);
  },

  async down(queryInterface) {
    // Body restored from 20260326204836-audit-ledger-allow-user-nullify.js.
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION verifywise.audit_ledger_prevent_delete()
      RETURNS trigger LANGUAGE plpgsql AS $func$
      BEGIN
        -- Allow if the parent organization no longer exists (FK cascade)
        IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'DELETE on audit_ledger is prohibited — append-only table';
      END;
      $func$;
    `);
  },
};
