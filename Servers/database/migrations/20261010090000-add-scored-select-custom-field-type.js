"use strict";

/**
 * Adds "scored_select" to the custom field type allowlist. Drops and re-adds
 * the CHECK constraint, which the original 20260520164729 migration baked the
 * allowlist into.
 */

const BASE_TYPES = ["text", "number", "date", "boolean", "select", "multiselect", "user"];

const typeList = (types) => types.map((t) => `'${t}'`).join(",");

const setAllowedTypes = (queryInterface, types) =>
  queryInterface.sequelize.query(`
    ALTER TABLE verifywise.custom_field_definitions
      DROP CONSTRAINT IF EXISTS cfd_field_type_allowed,
      ADD CONSTRAINT cfd_field_type_allowed
        CHECK (field_type IN (${typeList(types)}));
  `);

module.exports = {
  async up(queryInterface) {
    await setAllowedTypes(queryInterface, [...BASE_TYPES, "scored_select"]);
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(`
      SELECT COUNT(*)::int AS count
        FROM verifywise.custom_field_definitions
       WHERE field_type = 'scored_select';
    `);
    const count = Number(rows?.[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `Cannot roll back: ${count} scored select custom field(s) exist. Delete them first.`,
      );
    }
    await setAllowedTypes(queryInterface, BASE_TYPES);
  },
};
