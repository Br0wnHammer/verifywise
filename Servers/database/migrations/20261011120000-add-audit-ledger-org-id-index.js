"use strict";

/** Org-scoped keyset reads of the audit ledger (export batches, list). */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_ledger_org_id ON verifywise.audit_ledger (organization_id, id);`,
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS verifywise.idx_audit_ledger_org_id;`,
    );
  },
};
