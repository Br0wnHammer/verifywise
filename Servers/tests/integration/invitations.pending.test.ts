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
    await updateInvitationExpiryQuery(owner.orgId, row.id, resent);

    expect(
      (await getPendingInvitationQuery(owner.orgId, "invitee@example.com"))!.expires_at_ms,
    ).toBe(resent.getTime());
    expect(await getPendingInvitationQuery(attacker.orgId, "invitee@example.com")).toBeNull();
  });
});

describe("markInvitationAcceptedQuery", () => {
  it("counts the pending invitation it marks, and none the second time", async () => {
    const { owner } = await seedTwoTenantContexts();
    await createInvitationQuery(
      owner.orgId,
      "invitee@example.com",
      "In",
      "Vitee",
      3,
      owner.userId,
      new Date("2026-11-05T12:00:00.000Z"),
    );

    expect(await markInvitationAcceptedQuery(owner.orgId, "invitee@example.com")).toBe(1);
    expect(await markInvitationAcceptedQuery(owner.orgId, "invitee@example.com")).toBe(0);
    expect(await getPendingInvitationQuery(owner.orgId, "invitee@example.com")).toBeNull();
  });
});
