jest.setTimeout(60000);

import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { cleanupDatabase, createTestOrganization, createTestUser } from "./helpers";
import { createInvitationQuery } from "../../utils/invitation.utils";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("../../database/migrations/20261006210000-revoke-invites-the-invite-rules-refuse.js");

afterEach(async () => {
  await cleanupDatabase();
});

const EXPIRES = new Date("2026-11-05T12:00:00.000Z");

const invite = (orgId: number, email: string, roleId: number, invitedBy: number) =>
  createInvitationQuery(orgId, email, "In", "Vitee", roleId, invitedBy, EXPIRES);

const pendingEmails = async (orgId: number) =>
  (
    await sequelize.query<{ email: string }>(
      `SELECT email FROM invitations WHERE organization_id = :orgId AND status = 'pending' ORDER BY email`,
      { replacements: { orgId }, type: QueryTypes.SELECT },
    )
  ).map((r) => r.email);

// Before the /invite fix any logged-in user could invite anyone, with any
// role, into any organization. The migration removes the pending invitations
// the fixed rules would refuse, and keeps the rest.
describe("migration: revoke invitations the invite rules refuse", () => {
  it("revokes cross-org and non-admin built-in invites, keeps legitimate ones", async () => {
    const suffix = Date.now();
    const orgA = await createTestOrganization(`Org A ${suffix}`);
    const orgB = await createTestOrganization(`Org B ${suffix}`);
    const adminA = await createTestUser(orgA, 1, `admin-a-${suffix}@test.com`, "Password123!");
    const auditorA = await createTestUser(orgA, 4, `auditor-a-${suffix}@test.com`, "Password123!");
    const outsider = await createTestUser(orgB, 4, `outsider-${suffix}@test.com`, "Password123!");

    await invite(orgA, "kept-admin-invites-editor@x.com", 3, adminA);
    await invite(orgA, "kept-admin-invites-admin@x.com", 1, adminA);
    await invite(orgA, "revoked-outsider@x.com", 1, outsider);
    await invite(orgA, "revoked-auditor-grants-admin@x.com", 1, auditorA);
    await invite(orgA, "revoked-auditor-grants-auditor@x.com", 4, auditorA);
    // Accepted invitations are history, not live links: never touched.
    const accepted = await invite(orgA, "accepted-outsider@x.com", 1, outsider);
    await sequelize.query(`UPDATE invitations SET status = 'accepted' WHERE id = :id`, {
      replacements: { id: accepted.id },
    });

    await migration.up({ sequelize });

    expect(await pendingEmails(orgA)).toEqual([
      "kept-admin-invites-admin@x.com",
      "kept-admin-invites-editor@x.com",
    ]);
    const [{ count }] = await sequelize.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invitations WHERE id = :id`,
      { replacements: { id: accepted.id }, type: QueryTypes.SELECT },
    );
    expect(Number(count)).toBe(1);
  });

  it("keeps invites a super admin sent from outside the organization", async () => {
    const suffix = Date.now();
    const orgA = await createTestOrganization(`Org A ${suffix}`);
    const orgB = await createTestOrganization(`Org B ${suffix}`);
    const superAdmin = await createTestUser(orgB, 1, `super-${suffix}@test.com`, "Password123!");
    await sequelize.query(`INSERT INTO super_admins (user_id) VALUES (:id)`, {
      replacements: { id: superAdmin },
    });
    await invite(orgA, "kept-super-admin-invite@x.com", 1, superAdmin);

    await migration.up({ sequelize });

    expect(await pendingEmails(orgA)).toEqual(["kept-super-admin-invite@x.com"]);
  });

  it("revokes an invite into another organization's custom role", async () => {
    const suffix = Date.now();
    const orgA = await createTestOrganization(`Org A ${suffix}`);
    const orgB = await createTestOrganization(`Org B ${suffix}`);
    const adminA = await createTestUser(orgA, 1, `admin-a-${suffix}@test.com`, "Password123!");
    const [{ id: foreignRole }] = await sequelize.query<{ id: number }>(
      `INSERT INTO roles (name, description, organization_id, created_at)
       VALUES (:name, 'Custom', :orgB, NOW()) RETURNING id`,
      { replacements: { name: `Foreign ${suffix}`, orgB }, type: QueryTypes.SELECT },
    );
    await invite(orgA, "revoked-foreign-role@x.com", foreignRole, adminA);

    await migration.up({ sequelize });

    expect(await pendingEmails(orgA)).toEqual([]);
  });
});
