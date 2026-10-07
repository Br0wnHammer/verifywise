import { Request, Response } from "express";
import { STATUS_CODE } from "../utils/statusCode.utils";
import {
  getInvitationsByTenantQuery,
  getInvitationByIdQuery,
  revokeInvitationQuery,
  updateInvitationExpiryQuery,
} from "../utils/invitation.utils";
import { sendInviteEmail } from "../utils/inviteEmail.utils";
import { INVITATION_LIFETIME_MS } from "../utils/jwt.utils";

/**
 * GET /api/invitations
 * Returns all pending invitations for the authenticated user's organization.
 */
export const getInvitations = async (req: Request, res: Response): Promise<Response> => {
  try {
    const organizationId = req.organizationId!;
    const invitations = await getInvitationsByTenantQuery(organizationId);
    return res.status(200).json({ invitations });
  } catch (error) {
    console.error("Error fetching invitations:", error);
    return res.status(500).json(STATUS_CODE[500](req.t!("Failed to fetch invitations")));
  }
};

/**
 * DELETE /api/invitations/:id
 * Revoke a pending invitation.
 */
export const revokeInvitation = async (req: Request, res: Response): Promise<Response> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const organizationId = req.organizationId!;

    if (isNaN(id)) {
      return res.status(400).json(STATUS_CODE[400](req.t!("Invalid invitation ID")));
    }

    const deleted = await revokeInvitationQuery(organizationId, id);
    if (!deleted) {
      return res.status(404).json(STATUS_CODE[404](req.t!("Invitation not found")));
    }

    return res.status(200).json({ message: req.t!("Invitation revoked") });
  } catch (error) {
    console.error("Error revoking invitation:", error);
    return res.status(500).json(STATUS_CODE[500](req.t!("Failed to revoke invitation")));
  }
};

/**
 * POST /api/invitations/:id/resend
 * Resend an invitation email with a fresh token and updated expiry.
 */
export const resendInvitation = async (req: Request, res: Response): Promise<Response> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const organizationId = req.organizationId!;

    if (isNaN(id)) {
      return res.status(400).json(STATUS_CODE[400](req.t!("Invalid invitation ID")));
    }

    const invitation = await getInvitationByIdQuery(organizationId, id);
    if (!invitation) {
      return res.status(404).json(STATUS_CODE[404](req.t!("Invitation not found")));
    }

    // Save the new expiry first, then email a link signed for it: a link
    // only registers while it matches the row. If the save fails nothing is
    // sent and the invitee's current link keeps working.
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    const updated = await updateInvitationExpiryQuery(organizationId, id, expiresAt);
    if (updated === 0) {
      // Accepted or revoked since it was read: there is nothing to resend.
      return res.status(404).json(STATUS_CODE[404](req.t!("Invitation not found")));
    }

    const { link, info } = await sendInviteEmail({
      email: invitation.email,
      name: invitation.name,
      surname: invitation.surname,
      roleId: invitation.role_id,
      organizationId: organizationId,
      lang: req.lang,
      expiresAt,
    });

    if (info.error) {
      return res.status(206).json(
        STATUS_CODE[206]({
          error: `${info.error.name}: ${info.error.message}`,
          link,
        }),
      );
    }

    return res.status(200).json({ message: req.t!("Invitation resent successfully") });
  } catch (error) {
    console.error("Error resending invitation:", error);
    return res.status(500).json(STATUS_CODE[500](req.t!("Failed to resend invitation")));
  }
};
