"use strict";

/**
 * Revoke pending invitations that the fixed invite rules would refuse.
 *
 * Before the fix, POST /api/mail/invite only required a login and took the
 * organization and role from the request body, so any logged-in user could
 * invite anyone, as any role, into any organization. Such an invitation's
 * link still registers until it expires. This removes the pending ones the
 * rules now refuse (revoking an invitation deletes its pending row, as
 * revokeInvitationQuery does):
 *
 * - the inviter is not a member of the invitation's organization, unless the
 *   inviter is a super admin (super-admin invites come from outside the org);
 * - the role does not exist, is SuperAdmin, or is another organization's
 *   custom role;
 * - the role is a built-in one and the inviter is not that organization's
 *   Admin (only an Admin grants built-in roles), unless a super admin.
 *
 * Accepted invitations are left alone: they are history, not live links.
 * Legitimate pending invites a rule catches (for example from an Admin who
 * has since been demoted) can simply be sent again. Not reversible.
 */
module.exports = {
  async up(queryInterface) {
    const [revoked] = await queryInterface.sequelize.query(`
      DELETE FROM verifywise.invitations i
      WHERE i.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM verifywise.super_admins s WHERE s.user_id = i.invited_by
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM verifywise.users u
            WHERE u.id = i.invited_by AND u.organization_id = i.organization_id
          )
          OR NOT EXISTS (
            SELECT 1 FROM verifywise.roles r
            WHERE r.id = i.role_id
              AND r.name <> 'SuperAdmin'
              AND (r.organization_id IS NULL OR r.organization_id = i.organization_id)
          )
          OR (
            EXISTS (
              SELECT 1 FROM verifywise.roles r
              WHERE r.id = i.role_id AND r.organization_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM verifywise.users u
              JOIN verifywise.roles ur ON ur.id = u.role_id
              WHERE u.id = i.invited_by
                AND u.organization_id = i.organization_id
                AND ur.name = 'Admin'
                AND ur.organization_id IS NULL
            )
          )
        )
      RETURNING i.id, i.organization_id
    `);
    console.log(`Revoked ${revoked.length} pending invitation(s) the invite rules refuse.`);
  },

  async down() {
    // Revoked invitations cannot be restored; they can be sent again.
  },
};
