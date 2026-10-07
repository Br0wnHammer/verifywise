import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../../database/db", () => ({
  sequelize: { query: jest.fn() },
}));
jest.mock("../vwmailer.ctrl", () => ({
  invite: jest.fn(),
}));

import { inviteUserToOrg } from "../superAdmin.ctrl";
import { invite } from "../vwmailer.ctrl";
import { sequelize } from "../../database/db";

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
