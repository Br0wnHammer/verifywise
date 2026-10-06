import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../jwt.utils", () => ({
  generateInviteTokenUntil: jest.fn().mockReturnValue("mock-token-123"),
}));

jest.mock("../../config/constants", () => ({ frontEndUrl: "https://app.example.com" }));

jest.mock("../../services/emailService", () => ({
  sendEmail: jest.fn<() => Promise<any>>().mockResolvedValue({ messageId: "msg-123" }),
}));

jest.mock("fs/promises", () => ({
  readFile: jest.fn<() => Promise<string>>().mockResolvedValue("<mjml>template</mjml>"),
}));

import fs from "fs/promises";
import { generateInviteTokenUntil } from "../jwt.utils";
import { sendEmail } from "../../services/emailService";
import { sendInviteEmail } from "../inviteEmail.utils";

const mockGenerateInviteToken = generateInviteTokenUntil as jest.MockedFunction<
  typeof generateInviteTokenUntil
>;
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

describe("inviteEmail.utils", () => {
  const params = {
    email: "user@example.com",
    name: "John",
    surname: "Doe",
    roleId: 2,
    organizationId: 10,
    expiresAt: new Date("2026-11-05T12:00:00Z"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("sendInviteEmail", () => {
    it("should return correct link with token query param", async () => {
      const result = await sendInviteEmail(params);

      expect(result.link).toBe("https://app.example.com/user-reg?token=mock-token-123");
    });

    it("should sign the link with the invitee payload, expiring at expiresAt", async () => {
      const result = await sendInviteEmail(params);

      expect(mockGenerateInviteToken).toHaveBeenCalledTimes(1);
      const [payload, expiresAt] = mockGenerateInviteToken.mock.calls[0];
      expect(payload).toMatchObject({
        name: "John",
        surname: "Doe",
        roleId: 2,
        email: "user@example.com",
        organizationId: 10,
      });
      // The link expires at the stored invitations.expires_at.
      expect(expiresAt).toEqual(params.expiresAt);
      expect(result.link).toContain("mock-token-123");
    });

    it("should call sendEmail with correct args", async () => {
      await sendInviteEmail(params);

      expect(mockSendEmail).toHaveBeenCalledWith(
        "user@example.com",
        "Create your account",
        "<mjml>template</mjml>",
        expect.any(Object),
      );
      const callArgs = mockSendEmail.mock.calls[0];
      expect(callArgs[3]).toMatchObject({
        name: "John",
        link: "https://app.example.com/user-reg?token=mock-token-123",
      });
    });

    it("should handle sendEmail failure gracefully", async () => {
      mockSendEmail.mockRejectedValue(new Error("SMTP error"));

      await expect(sendInviteEmail(params)).rejects.toThrow("SMTP error");
    });

    it("should handle fs.readFile failure gracefully", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      await expect(sendInviteEmail(params)).rejects.toThrow("ENOENT");
    });
  });
});
