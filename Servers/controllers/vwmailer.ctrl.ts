import { Request, Response } from "express";
import { STATUS_CODE } from "../utils/statusCode.utils";
import { logProcessing, logSuccess, logFailure } from "../utils/logger/logHelper";
import logger from "../utils/logger/fileLogger";
import { createInvitationQuery } from "../utils/invitation.utils";
import { sendInviteEmail } from "../utils/inviteEmail.utils";
import { INVITATION_LIFETIME_MS } from "../utils/jwt.utils";

export const invite = async (
  req: Request,
  res: Response,
  body: {
    to: string;
    name: string;
    surname?: string;
    roleId: number;
    organizationId: number;
  },
) => {
  const { to, name, surname, roleId, organizationId } = body;

  logProcessing({
    description: `starting invite email for user: ${to}`,
    functionName: "invite",
    fileName: "vwmailer.ctrl.ts",
    userId: req.userId!,
    organizationId,
  });
  logger.debug(`📧 Sending invitation email to ${to} for user ${name} ${surname || ""}`);

  try {
    // Save the invitation first: its link only registers while it matches
    // this row, so a link for an unsaved row would never work. A failure
    // here is a 500 and no email goes out.
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    await createInvitationQuery(
      organizationId,
      to,
      name,
      surname || "",
      roleId,
      req.userId!,
      expiresAt,
    );

    const { link, info } = await sendInviteEmail({
      email: to,
      name,
      surname,
      roleId,
      organizationId,
      lang: req.lang,
      expiresAt,
    });

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
