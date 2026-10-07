import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { Request, Response } from "express";

jest.mock("../../utils/invitation.utils", () => ({
  getInvitationsByTenantQuery: jest.fn(),
  getInvitationByIdQuery: jest.fn(),
  revokeInvitationQuery: jest.fn(),
  updateInvitationExpiryQuery: jest.fn(),
}));

jest.mock("../../utils/inviteEmail.utils", () => ({
  sendInviteEmail: jest.fn(),
}));

// Import controller AFTER mocks
import { getInvitations, revokeInvitation, resendInvitation } from "../invitation.ctrl";
import {
  getInvitationsByTenantQuery,
  getInvitationByIdQuery,
  revokeInvitationQuery,
  updateInvitationExpiryQuery,
} from "../../utils/invitation.utils";
import { sendInviteEmail } from "../../utils/inviteEmail.utils";

const mockGetAll = getInvitationsByTenantQuery as jest.MockedFunction<
  typeof getInvitationsByTenantQuery
>;
const mockGetById = getInvitationByIdQuery as jest.MockedFunction<typeof getInvitationByIdQuery>;
const mockRevoke = revokeInvitationQuery as jest.MockedFunction<typeof revokeInvitationQuery>;
const mockUpdateExpiry = updateInvitationExpiryQuery as jest.MockedFunction<
  typeof updateInvitationExpiryQuery
>;
const mockSendEmail = sendInviteEmail as jest.MockedFunction<typeof sendInviteEmail>;

function createReq(overrides?: Partial<Request>): any {
  return {
    userId: 1,
    organizationId: 1,
    role: "Admin",
    t: (k: string) => k,
    body: {},
    params: {},
    query: {},
    lang: "en",
    ...overrides,
  };
}

function createRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("invitation.ctrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getInvitations", () => {
    it("should return 200 with invitations", async () => {
      const invitationsData = [{ id: 1, email: "a@b.com" }];
      mockGetAll.mockResolvedValue(invitationsData as any);
      const req = createReq();
      const res = createRes();

      await getInvitations(req, res);

      expect(mockGetAll).toHaveBeenCalledWith(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ invitations: invitationsData });
    });

    it("should return 200 with empty array", async () => {
      mockGetAll.mockResolvedValue([]);
      const req = createReq();
      const res = createRes();

      await getInvitations(req, res);

      expect(mockGetAll).toHaveBeenCalledWith(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ invitations: [] });
    });

    it("should return 500 on error", async () => {
      mockGetAll.mockRejectedValue(new Error("DB error"));
      const req = createReq();
      const res = createRes();

      await getInvitations(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal Server Error",
        error: "Failed to fetch invitations",
      });
    });
  });

  describe("revokeInvitation", () => {
    it("should return 200 when invitation is revoked", async () => {
      mockRevoke.mockResolvedValue({ id: 1 } as any);
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await revokeInvitation(req, res);

      expect(mockRevoke).toHaveBeenCalledWith(1, 1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ message: "Invitation revoked" });
    });

    it("should return 400 for invalid ID", async () => {
      const req = createReq({ params: { id: "abc" } });
      const res = createRes();

      await revokeInvitation(req, res);

      expect(mockRevoke).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Bad Request",
        data: "Invalid invitation ID",
      });
    });

    it("should return 404 when invitation not found", async () => {
      mockRevoke.mockResolvedValue(null);
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await revokeInvitation(req, res);

      expect(mockRevoke).toHaveBeenCalledWith(1, 1);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: "Not Found",
        data: "Invitation not found",
      });
    });

    it("should return 500 on error", async () => {
      mockRevoke.mockRejectedValue(new Error("DB error"));
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await revokeInvitation(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal Server Error",
        error: "Failed to revoke invitation",
      });
    });
  });

  describe("resendInvitation", () => {
    it("should return 200 when resent successfully", async () => {
      mockGetById.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      } as any);
      mockSendEmail.mockResolvedValue({
        link: "link",
        info: {},
      } as any);
      mockUpdateExpiry.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      });
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockGetById).toHaveBeenCalledWith(1, 1);
      // The new expiry is saved first, and the link is signed for it.
      const savedExpiry = mockUpdateExpiry.mock.calls[0][2];
      expect(savedExpiry).toBeInstanceOf(Date);
      expect(mockUpdateExpiry).toHaveBeenCalledWith(1, 1, savedExpiry);
      expect(mockSendEmail).toHaveBeenCalledWith({
        email: "a@b.com",
        name: "A",
        surname: "B",
        roleId: 1,
        organizationId: 1,
        lang: "en",
        expiresAt: savedExpiry,
      });
      expect(mockUpdateExpiry.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendEmail.mock.invocationCallOrder[0],
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        message: "Invitation resent successfully",
      });
    });

    it("should return 206 when email fails", async () => {
      mockGetById.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      } as any);
      mockSendEmail.mockResolvedValue({
        link: "link",
        info: { error: { name: "SendError", message: "fail" } },
      } as any);
      mockUpdateExpiry.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      });
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockGetById).toHaveBeenCalledWith(1, 1);
      // The new expiry is saved first, and the link is signed for it.
      const savedExpiry = mockUpdateExpiry.mock.calls[0][2];
      expect(savedExpiry).toBeInstanceOf(Date);
      expect(mockUpdateExpiry).toHaveBeenCalledWith(1, 1, savedExpiry);
      expect(mockSendEmail).toHaveBeenCalledWith({
        email: "a@b.com",
        name: "A",
        surname: "B",
        roleId: 1,
        organizationId: 1,
        lang: "en",
        expiresAt: savedExpiry,
      });
      expect(mockUpdateExpiry.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendEmail.mock.invocationCallOrder[0],
      );
      expect(res.status).toHaveBeenCalledWith(206);
      expect(res.json).toHaveBeenCalledWith({
        message: "Partial Content",
        data: {
          error: "SendError: fail",
          link: "link",
        },
      });
    });

    it("signs the link for the role the row holds after the update", async () => {
      // A re-invite between the read and the update can change the role; a
      // link signed with the stale role would never register.
      mockGetById.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 3,
      } as any);
      mockUpdateExpiry.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 2,
      });
      mockSendEmail.mockResolvedValue({ link: "link", info: {} } as any);
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ roleId: 2 }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("sends nothing when the new expiry cannot be saved", async () => {
      // An emailed link only registers while it matches the row; a link for
      // an unsaved expiry would be dead on arrival.
      mockGetById.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      } as any);
      mockUpdateExpiry.mockRejectedValue(new Error("db down"));
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it("returns 404 and sends nothing when the invitation stopped being pending", async () => {
      // Accepted or revoked between the read and the update: no row updated.
      mockGetById.mockResolvedValue({
        email: "a@b.com",
        name: "A",
        surname: "B",
        role_id: 1,
      } as any);
      mockUpdateExpiry.mockResolvedValue(null);
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: "Not Found",
        data: "Invitation not found",
      });
    });

    it("should return 400 for invalid ID", async () => {
      const req = createReq({ params: { id: "abc" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockGetById).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        message: "Bad Request",
        data: "Invalid invitation ID",
      });
    });

    it("should return 404 when invitation not found", async () => {
      mockGetById.mockResolvedValue(null);
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(mockGetById).toHaveBeenCalledWith(1, 1);
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: "Not Found",
        data: "Invitation not found",
      });
    });

    it("should return 500 on error", async () => {
      mockGetById.mockRejectedValue(new Error("DB error"));
      const req = createReq({ params: { id: "1" } });
      const res = createRes();

      await resendInvitation(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal Server Error",
        error: "Failed to resend invitation",
      });
    });
  });
});
