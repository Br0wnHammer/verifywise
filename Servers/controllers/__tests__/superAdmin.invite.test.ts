import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../../database/db", () => ({
  sequelize: { query: jest.fn(), transaction: jest.fn() },
}));
jest.mock("../vwmailer.ctrl", () => ({
  invite: jest.fn(),
}));
jest.mock("../../utils/organization.utils", () => ({
  createOrganizationQuery: jest.fn(),
}));
jest.mock("../../utils/invitation.utils", () => ({
  createInvitationQuery: jest.fn(),
  getInvitationsByOrganizationQuery: jest.fn(),
}));
jest.mock("../../domain.layer/models/organization/organization.model", () => ({
  OrganizationModel: { createNewOrganization: jest.fn(async () => ({})) },
}));
jest.mock("../../utils/inviteRole.utils", () => ({
  inviteRoleRefusal: jest.fn(),
}));

import { createOrgWithUser, inviteUserToOrg } from "../superAdmin.ctrl";
import { invite } from "../vwmailer.ctrl";
import { sequelize } from "../../database/db";
import { createOrganizationQuery } from "../../utils/organization.utils";
import { createInvitationQuery } from "../../utils/invitation.utils";
import { inviteRoleRefusal } from "../../utils/inviteRole.utils";

const mockInvite = invite as jest.MockedFunction<typeof invite>;
const mockQuery = sequelize.query as unknown as jest.Mock;

const createRes = (): any => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe("superAdmin.ctrl inviteUserToOrg", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // No existing user with the email; the organization exists.
    mockQuery.mockImplementation(async (sql: unknown) =>
      String(sql).includes("FROM organizations") ? [{ id: 12 }] : [],
    );
  });

  it("invites into the organization from the route, passed as trusted", async () => {
    // invite() ignores an organization in the body, so the route's
    // organization must arrive as the trusted argument.
    const req: any = {
      params: { id: "12" },
      body: { email: "new@x.com", name: "New", surname: "User", roleId: 3 },
      t: (k: string) => k,
    };
    const res = createRes();

    await inviteUserToOrg(req, res);

    expect(mockInvite).toHaveBeenCalledWith(
      req,
      res,
      { to: "new@x.com", name: "New", surname: "User", roleId: 3 },
      { organizationId: 12 },
    );
  });

  it("refuses an organization id that is not a positive integer", async () => {
    const req: any = {
      params: { id: "abc" },
      body: { email: "new@x.com", name: "New", roleId: 3 },
      t: (k: string) => k,
    };
    const res = createRes();

    await inviteUserToOrg(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it("answers 404 for an organization that does not exist", async () => {
    mockQuery.mockResolvedValue([] as never);
    const req: any = {
      params: { id: "999" },
      body: { email: "new@x.com", name: "New", roleId: 3 },
      t: (k: string) => k,
    };
    const res = createRes();

    await inviteUserToOrg(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockInvite).not.toHaveBeenCalled();
  });
});

describe("superAdmin.ctrl inviteUserToOrg lookup errors", () => {
  it("answers 500 when the organization lookup fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down") as never);
    const req: any = {
      params: { id: "12" },
      body: { email: "new@x.com", name: "New", roleId: 3 },
      t: (k: string) => k,
    };
    const res = createRes();

    await inviteUserToOrg(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockInvite).not.toHaveBeenCalled();
  });
});

describe("superAdmin.ctrl createOrgWithUser (invite mode)", () => {
  const transaction = { commit: jest.fn(), rollback: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    (sequelize.transaction as unknown as jest.Mock).mockResolvedValue(transaction as never);
    (createOrganizationQuery as unknown as jest.Mock).mockResolvedValue({ id: 30 } as never);
  });

  it("refuses a role the invite rules refuse, without saving the organization", async () => {
    (inviteRoleRefusal as unknown as jest.Mock).mockResolvedValue("unknown_role" as never);
    const req: any = {
      body: {
        orgName: "Acme",
        mode: "invite",
        user: { email: "new@x.com", name: "New", roleId: 60 },
      },
      userId: 1,
      t: (k: string) => k,
    };
    const res = createRes();

    await createOrgWithUser(req, res);

    expect(inviteRoleRefusal).toHaveBeenCalledWith(30, null, 60);
    expect(createInvitationQuery).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
