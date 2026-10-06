jest.setTimeout(60000);

import { cleanupDatabase } from "./helpers";
import { seedTwoTenantContexts } from "./tenant-isolation/tenantIsolation.harness";
import {
  createInvitationQuery,
  getPendingInvitationQuery,
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
