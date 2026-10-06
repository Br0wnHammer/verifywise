import { Request, Response } from "express";
import { STATUS_CODE } from "../utils/statusCode.utils";
import { logProcessing, logSuccess, logFailure } from "../utils/logger/logHelper";
import logger from "../utils/logger/fileLogger";
import { createInvitationQuery } from "../utils/invitation.utils";
import { sendInviteEmail } from "../utils/inviteEmail.utils";
import { getRoleInfoById } from "../utils/roleMap";
import { getEffectivePermissions } from "../utils/rolePermissions.utils";

/**
 * Why the inviter may not grant this role, or null if they may. The role must
 * exist, be a built-in or this organization's own, and carry no permission
 * the inviter lacks, so an invite never grants more access than the
 * inviter's own role.
 */
async function roleRefusal(
  organizationId: number,
  inviterRole: string,
  roleId: number,
): Promise<{ status: 400 | 403; message: string } | null> {
  const role = await getRoleInfoById(roleId);
  // SuperAdmin is granted through the super_admins mapping, never an invite.
  if (
    !role ||
    role.name === "SuperAdmin" ||
    (role.organizationId !== null && role.organizationId !== organizationId)
  ) {
    return { status: 400, message: "Unknown role" };
  }
  const [granted, held] = await Promise.all([
    getEffectivePermissions(organizationId, role.name),
    getEffectivePermissions(organizationId, inviterRole),
  ]);
  for (const permission of granted) {
    if (!held.has(permission)) {
      return { status: 403, message: "You cannot invite a user with more access than your own" };
    }
  }
  return null;
}

export const invite = async (
  req: Request,
  res: Response,
  body: {
    to: string;
    name: string;
    surname?: string;
    roleId: number | string;
    /** Ignored: an invite always goes to the inviter's own organization. */
    organizationId?: number | string;
  },
) => {
  const { to, name, surname } = body;
  const organizationId = req.organizationId;
  if (organizationId == null) {
    return res.status(403).json(STATUS_CODE[403](req.t!("Not allowed to access")));
  }
  // The invite form sends the id as a string.
  const roleId = Number(body.roleId);
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return res.status(400).json(STATUS_CODE[400](req.t!("Unknown role")));
  }
  try {
    const refusal = await roleRefusal(organizationId, req.role!, roleId);
    if (refusal) {
      return res.status(refusal.status).json(STATUS_CODE[refusal.status](req.t!(refusal.message)));
    }
  } catch (error) {
    await logFailure({
      eventType: "Create",
      description: `Failed to check the role for an invitation to ${to}`,
      functionName: "invite",
      fileName: "vwmailer.ctrl.ts",
      error: error as Error,
      userId: req.userId!,
      organizationId,
    });
    return res.status(500).json(
      STATUS_CODE[500]({
        error: req.t!("Failed to send email"),
        details: (error as Error).message,
      }),
    );
  }

  logProcessing({
    description: `starting invite email for user: ${to}`,
    functionName: "invite",
    fileName: "vwmailer.ctrl.ts",
    userId: req.userId!,
    organizationId,
  });
  logger.debug(`📧 Sending invitation email to ${to} for user ${name} ${surname || ""}`);

  try {
    const { link, expiresAt, info } = await sendInviteEmail({
      email: to,
      name,
      surname,
      roleId,
      organizationId,
      lang: req.lang,
    });

    // Persist invitation record
    try {
      await createInvitationQuery(
        organizationId,
        to,
        name,
        surname || "",
        roleId,
        req.userId!,
        expiresAt,
      );
    } catch (invErr) {
      console.error("Failed to persist invitation record:", invErr);
    }

    if (info.error) {
      console.error("Error sending email:", info.error);
      await logFailure({
        eventType: "Create",
        description: `Failed to send invitation email to ${to}: ${info.error.name}: ${info.error.message}`,
        functionName: "invite",
        fileName: "vwmailer.ctrl.ts",
        error: new Error(`${info.error.name}: ${info.error.message}`),
        userId: req.userId!,
        organizationId,
      });
      return res.status(206).json(
        STATUS_CODE[206]({
          error: `${info.error.name}: ${info.error.message}`,
          link,
        }),
      );
    } else {
      await logSuccess({
        eventType: "Create",
        description: `Successfully sent invitation email to ${to} for user ${name}`,
        functionName: "invite",
        fileName: "vwmailer.ctrl.ts",
        userId: req.userId!,
        organizationId,
      });
      return res.status(200).json({ message: req.t!("Email sent successfully") });
    }
  } catch (error) {
    console.error("Error sending email:", error);
    await logFailure({
      eventType: "Create",
      description: `Failed to send invitation email to ${to}`,
      functionName: "invite",
      fileName: "vwmailer.ctrl.ts",
      error: error as Error,
      userId: req.userId!,
      organizationId,
    });
    return res.status(500).json(
      STATUS_CODE[500]({
        error: req.t!("Failed to send email"),
        details: (error as Error).message,
      }),
    );
  }
};
