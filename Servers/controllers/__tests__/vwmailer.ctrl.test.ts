import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { BUILTIN_ROLE_PERMISSIONS } from "../../config/rolePermissions.config";

jest.mock("../../utils/inviteEmail.utils", () => ({
  sendInviteEmail: jest.fn(),
}));
jest.mock("../../utils/invitation.utils", () => ({
  createInvitationQuery: jest.fn(),
}));
jest.mock("../../utils/roleMap", () => ({
  getRoleInfoById: jest.fn(),
}));
jest.mock("../../utils/rolePermissions.utils", () => ({
  getEffectivePermissions: jest.fn(),
}));
jest.mock("../../utils/logger/logHelper", () => ({
  logProcessing: jest.fn(),
  logSuccess: jest.fn(),
  logFailure: jest.fn(),
}));

import { invite } from "../vwmailer.ctrl";
import { sendInviteEmail } from "../../utils/inviteEmail.utils";
import { createInvitationQuery } from "../../utils/invitation.utils";
import { getRoleInfoById } from "../../utils/roleMap";
import { getEffectivePermissions } from "../../utils/rolePermissions.utils";

const mockSend = sendInviteEmail as jest.MockedFunction<typeof sendInviteEmail>;
const mockCreate = createInvitationQuery as jest.MockedFunction<typeof createInvitationQuery>;
const mockGetRole = getRoleInfoById as jest.MockedFunction<typeof getRoleInfoById>;
const mockPermissions = getEffectivePermissions as jest.MockedFunction<
  typeof getEffectivePermissions
>;

const ROLES: Record<number, { id: number; name: string; organizationId: number | null }> = {
  1: { id: 1, name: "Admin", organizationId: null },
  3: { id: 3, name: "Editor", organizationId: null },
  4: { id: 4, name: "Auditor", organizationId: null },
  5: { id: 5, name: "SuperAdmin", organizationId: null },
  50: { id: 50, name: "Team lead", organizationId: 42 },
  60: { id: 60, name: "Other org role", organizationId: 7 },
};

// "Team lead": a custom role that may invite, with reader access otherwise.
const TEAM_LEAD = new Set<string>([...BUILTIN_ROLE_PERMISSIONS.Auditor, "invitation.super"]);

function createReq(overrides: Record<string, unknown> = {}): any {
  return {
    userId: 9,
    organizationId: 42,
    role: "Admin",
    t: (k: string) => k,
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

const body = (overrides: Record<string, unknown> = {}): any => ({
  to: "new@example.com",
  name: "New",
  roleId: 3,
  organizationId: 42,
  ...overrides,
});

describe("vwmailer.ctrl invite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRole.mockImplementation(async (id: number) => ROLES[id]);
    mockPermissions.mockImplementation(async (_org, roleName: string) =>
      roleName === "Team lead" ? TEAM_LEAD : (BUILTIN_ROLE_PERMISSIONS[roleName] ?? new Set()),
    );
    mockSend.mockResolvedValue({
      link: "http://x/user-reg?token=t",
      expiresAt: new Date(),
      info: {},
    } as any);
    mockCreate.mockResolvedValue({} as any);
  });

  it("invites into the inviter's organization, ignoring the body's", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ organizationId: 7 }));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 42 }));
    expect(mockCreate.mock.calls[0][0]).toBe(42);
  });

  it("accepts the role id as a numeric string, as the invite form sends it", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: "3" }));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ roleId: 3 }));
  });

  it("refuses a caller without an organization", async () => {
    const res = createRes();
    await invite(createReq({ organizationId: undefined }), res, body());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([["abc"], [0], [-1], [1.5], [undefined]])("refuses role id %p", async (roleId) => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId }));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses an unknown role", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: 999 }));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses another organization's custom role", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: 60 }));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses the SuperAdmin role, even for an Admin", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: 5 }));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("lets an Admin invite an Admin", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: 1 }));

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("lets an Admin invite into the organization's custom role", async () => {
    const res = createRes();
    await invite(createReq(), res, body({ roleId: 50 }));

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("refuses a role with access the inviter does not have", async () => {
    // A custom role allowed to invite must not hand out Admin or Editor.
    for (const roleId of [1, 3]) {
      const res = createRes();
      await invite(createReq({ role: "Team lead" }), res, body({ roleId }));
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("lets an inviter grant a role within their own access", async () => {
    const res = createRes();
    await invite(createReq({ role: "Team lead" }), res, body({ roleId: 4 }));

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 500 without sending when the role lookup fails", async () => {
    mockGetRole.mockRejectedValueOnce(new Error("db down"));
    const res = createRes();
    await invite(createReq(), res, body());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
