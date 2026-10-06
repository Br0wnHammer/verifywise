import path from "path";
import fs from "fs/promises";
import { generateInviteTokenUntil, INVITATION_LIFETIME_MS } from "./jwt.utils";
import { frontEndUrl } from "../config/constants";
import { sendEmail } from "../services/emailService";
import { translate } from "./i18n.utils";

interface InviteEmailParams {
  email: string;
  name: string;
  surname?: string;
  roleId: number;
  organizationId: number;
  /**
   * Inviter's language. The invitee gets the email in the inviter's locale.
   * TODO(i18n-v2): for known recipients, prefer their stored language via
   * `getPreferencesByUserQuery(recipientUserId).language`. Invitees have no
   * user record yet, so the inviter's locale stays the right default.
   */
  lang?: string;
  /**
   * When the link expires. Defaults to the invitation lifetime from now; a
   * caller that has already stored the invitation row passes its expires_at.
   */
  expiresAt?: Date;
}

interface InviteEmailResult {
  link: string;
  expiresAt: Date;
  info: { error?: { name: string; message: string } };
}

/**
 * Generates a token, builds the invite link, and sends the invite email.
 * Shared by initial invite (vwmailer) and resend (invitation controller).
 */
export const sendInviteEmail = async (params: InviteEmailParams): Promise<InviteEmailResult> => {
  const { email, name, surname, roleId, organizationId, lang } = params;

  // One instant for the link and the stored invitations.expires_at, fixed
  // before the SMTP round trip.
  const expiresAt = params.expiresAt ?? new Date(Date.now() + INVITATION_LIFETIME_MS);
  const token = generateInviteTokenUntil(
    {
      name,
      surname,
      roleId,
      email,
      organizationId,
    },
    expiresAt,
  ) as string;

  const link = `${frontEndUrl}/user-reg?${new URLSearchParams({
    token,
  }).toString()}`;

  const templatePath = path.resolve(__dirname, "../templates/account-creation-email.mjml");
  const template = await fs.readFile(templatePath, "utf8");

  const subject = translate(lang, "Create your account");
  const info = await sendEmail(email, subject, template, {
    name,
    link,
  });

  return { link, expiresAt, info };
};
