"use strict";

/**
 * Org-scoped keyset reads of the audit ledger (export batches, list).
 *
 * CONCURRENTLY, so building the index does not block ledger inserts, which
 * run in the request path of every audited write. It cannot run inside a
 * transaction; sequelize-cli runs each statement on its own.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_ledger_org_id ON verifywise.audit_ledger (organization_id, id);`,
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX CONCURRENTLY IF EXISTS verifywise.idx_audit_ledger_org_id;`,
    );
  },
};
