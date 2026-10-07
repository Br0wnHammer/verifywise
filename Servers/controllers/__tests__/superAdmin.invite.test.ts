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
    mockQuery.mockResolvedValue([] as never);
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
});
