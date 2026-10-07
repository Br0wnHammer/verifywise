jest.setTimeout(60000);

import { cleanupDatabase } from "./helpers";
import { QueryTypes } from "sequelize";
import { sequelize } from "../../database/db";
import { seedTwoTenantContexts } from "./tenant-isolation/tenantIsolation.harness";
import {
  createInvitationQuery,
  getPendingInvitationQuery,
  markInvitationAcceptedQuery,
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
        transaction,
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
    const row = await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      first,
    );
    const resent = new Date("2026-11-06T09:30:00.250Z");
    expect(await updateInvitationExpiryQuery(attacker.orgId, row.id, resent)).toBe(0);
    expect(await updateInvitationExpiryQuery(owner.orgId, row.id, resent)).toBe(1);

    expect(
      (await getPendingInvitationQuery(owner.orgId, "invitee@example.com"))!.expires_at_ms,
    ).toBe(resent.getTime());
    expect(await getPendingInvitationQuery(attacker.orgId, "invitee@example.com")).toBeNull();
  });

  it("does not extend an invitation that is no longer pending", async () => {
    const { owner } = await seedTwoTenantContexts();
    const first = new Date("2026-11-05T12:00:00.000Z");
    const row = await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      first,
    );
    expect(
      await markInvitationAcceptedQuery(owner.orgId, {
        id: row.id,
        roleId: 3,
        expiresAtMs: first.getTime(),
      }),
    ).toBe(1);

    expect(
      await updateInvitationExpiryQuery(owner.orgId, row.id, new Date("2026-11-06T09:30:00Z")),
    ).toBe(0);
  });
});

describe("markInvitationAcceptedQuery", () => {
  const EXPIRES = new Date("2026-11-05T12:00:00.000Z");

  it("accepts the checked invitation once, and only from its organization", async () => {
    const { owner, attacker } = await seedTwoTenantContexts();
    const row = await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      EXPIRES,
    );
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
    const row = await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      EXPIRES,
    );
    const checked = { id: row.id, roleId: 3, expiresAtMs: EXPIRES.getTime() };
    const reinvited = await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      4,
      owner.userId,
      new Date("2026-11-06T12:00:00.000Z"),
    );
    expect(reinvited.id).toBe(row.id);

    expect(await markInvitationAcceptedQuery(owner.orgId, checked)).toBe(0);
  });
});
