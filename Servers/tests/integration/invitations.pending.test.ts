jest.setTimeout(60000);

import { cleanupDatabase } from "./helpers";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { seedTwoTenantContexts } from "./tenant-isolation/tenantIsolation.harness";
import {
  createInvitationQuery,
  getPendingInvitationQuery,
  markInvitationAcceptedQuery,
  revokeInvitationQuery,
  updateInvitationExpiryQuery,
} from "../../utils/invitation.utils";

afterEach(async () => {
  await cleanupDatabase();
});

// register.middleware compares an invite link's `expire` (epoch ms) with the
// stored expires_at, a TIMESTAMP without zone. The round trip must give back
// the exact instant, whatever the database session's time zone.
describe("getPendingInvitationQuery", () => {
  it("returns the stored expiry as the same epoch milliseconds", async () => {
    const { owner } = await seedTwoTenantContexts();
    const expiresAt = new Date("2026-11-05T13:14:15.678Z");
    await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      expiresAt,
    );

    const invitation = await getPendingInvitationQuery(owner.orgId, "invitee@example.com");

    expect(invitation).not.toBeNull();
    expect(invitation!.role_id).toBe(3);
    expect(invitation!.expires_at_ms).toBe(expiresAt.getTime());
  });

  it("round-trips the same instant in a non-UTC session time zone", async () => {
    const { owner } = await seedTwoTenantContexts();
    const expiresAt = new Date("2026-11-05T13:14:15.678Z");

    // SET LOCAL needs one connection, so write and read in one transaction.
    const expiresAtMs = await sequelize.transaction(async (transaction) => {
      await sequelize.query("SET LOCAL TIME ZONE 'America/Toronto'", { transaction });
      await createInvitationQuery(
        owner.orgId,
        "invitee@example.com",
        "In",
        "Vitee",
        3,
        owner.userId,
        expiresAt,
        { transaction },
      );
      const [zone] = (await sequelize.query("SELECT current_setting('TimeZone') AS tz", {
        transaction,
        type: QueryTypes.SELECT,
      })) as { tz: string }[];
      expect(zone.tz).toBe("America/Toronto");
      return (await getPendingInvitationQuery(owner.orgId, "invitee@example.com", transaction))!
        .expires_at_ms;
    });

    expect(expiresAtMs).toBe(expiresAt.getTime());
  });

  it("follows a resend's new expiry and ignores other organizations", async () => {
    const { owner, attacker } = await seedTwoTenantContexts();
    const first = new Date("2026-11-05T12:00:00.000Z");
    const row = (await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      first,
    ))!;
    const resent = new Date("2026-11-06T09:30:00.250Z");
    expect(await updateInvitationExpiryQuery(attacker.orgId, row.id, 3, resent)).toBeNull();
    expect(await updateInvitationExpiryQuery(owner.orgId, row.id, 3, resent)).toMatchObject({
      email: "invitee@example.com",
      role_id: 3,
    });

    expect(
      (await getPendingInvitationQuery(owner.orgId, "invitee@example.com"))!.expires_at_ms,
    ).toBe(resent.getTime());
    expect(await getPendingInvitationQuery(attacker.orgId, "invitee@example.com")).toBeNull();
  });

  it("does not extend an invitation that is no longer pending", async () => {
    const { owner } = await seedTwoTenantContexts();
    const first = new Date("2026-11-05T12:00:00.000Z");
    const row = (await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      first,
    ))!;
    expect(
      await markInvitationAcceptedQuery(owner.orgId, {
        id: row.id,
        roleId: 3,
        expiresAtMs: first.getTime(),
      }),
    ).toBe(1);

    expect(
      await updateInvitationExpiryQuery(owner.orgId, row.id, 3, new Date("2026-11-06T09:30:00Z")),
    ).toBeNull();
  });
});

describe("markInvitationAcceptedQuery", () => {
  const EXPIRES = new Date("2026-11-05T12:00:00.000Z");

  it("accepts the checked invitation once, and only from its organization", async () => {
    const { owner, attacker } = await seedTwoTenantContexts();
    const row = (await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      EXPIRES,
    ))!;
    const checked = { id: row.id, roleId: 3, expiresAtMs: EXPIRES.getTime() };

    expect(await markInvitationAcceptedQuery(attacker.orgId, checked)).toBe(0);
    expect(await markInvitationAcceptedQuery(owner.orgId, checked)).toBe(1);
    expect(await markInvitationAcceptedQuery(owner.orgId, checked)).toBe(0);
    expect(await getPendingInvitationQuery(owner.orgId, "invitee@example.com")).toBeNull();
  });

  it("does not accept a row a re-invite rewrote after the link was checked", async () => {
    // A re-invite of a pending email updates the same row (same id) with the
    // new role and expiry; the link that was checked must no longer count.
    const { owner } = await seedTwoTenantContexts();
    const row = (await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      EXPIRES,
    ))!;
    const checked = { id: row.id, roleId: 3, expiresAtMs: EXPIRES.getTime() };
    const reinvited = (await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      4,
      owner.userId,
      new Date("2026-11-06T12:00:00.000Z"),
    ))!;
    expect(reinvited.id).toBe(row.id);

    expect(await markInvitationAcceptedQuery(owner.orgId, checked)).toBe(0);
  });
});

// Resend, revoke and re-invite check the caller against the role they read;
// each write must miss when a re-invite changed the role in between.
describe("role-guarded invitation writes", () => {
  const EXPIRES = new Date("2026-11-05T12:00:00.000Z");
  const LATER = new Date("2026-11-06T12:00:00.000Z");
  const invite = (
    orgId: number,
    roleId: number,
    invitedBy: number,
    replaceRoleId?: number | null,
  ) =>
    createInvitationQuery(orgId, "invitee@example.com", "In", "Vitee", roleId, invitedBy, EXPIRES, {
      replaceRoleId,
    });

  it("does not extend or revoke an invitation whose role changed since it was checked", async () => {
    const { owner } = await seedTwoTenantContexts();
    const row = (await invite(owner.orgId, 3, owner.userId))!;
    await invite(owner.orgId, 1, owner.userId);

    expect(await updateInvitationExpiryQuery(owner.orgId, row.id, 3, LATER)).toBeNull();
    expect(await revokeInvitationQuery(owner.orgId, row.id, 3)).toBe(false);
    expect(await getPendingInvitationQuery(owner.orgId, "invitee@example.com")).toMatchObject({
      role_id: 1,
      expires_at_ms: EXPIRES.getTime(),
    });
    expect(await revokeInvitationQuery(owner.orgId, row.id, 1)).toBe(true);
  });

  it("replaces a pending invitation only while it holds the checked role", async () => {
    const { owner } = await seedTwoTenantContexts();
    await invite(owner.orgId, 1, owner.userId);

    // Checked against role 3 (or against no invitation): the Admin one stays.
    expect(await invite(owner.orgId, 4, owner.userId, 3)).toBeNull();
    expect(await invite(owner.orgId, 4, owner.userId, null)).toBeNull();
    expect(await getPendingInvitationQuery(owner.orgId, "invitee@example.com")).toMatchObject({
      role_id: 1,
    });

    expect(await invite(owner.orgId, 4, owner.userId, 1)).toMatchObject({ role_id: 4 });
  });

  it("inserts when there is no pending invitation, guarded or not", async () => {
    const { owner } = await seedTwoTenantContexts();
    expect(await invite(owner.orgId, 3, owner.userId, null)).toMatchObject({ role_id: 3 });
  });
});
