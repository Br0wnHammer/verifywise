import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../../database/db", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("../../../utils/user.utils", () => ({ getUserByIdQuery: jest.fn() }));
jest.mock("../../../utils/roleMap", () => ({ getRoleNameById: jest.fn() }));
jest.mock("../../../utils/rolePermissions.utils", () => ({ roleHasPermission: jest.fn() }));

import { availableAuditLedgerTools } from "../../functions/auditLedgerFunctions";
import { sequelize } from "../../../database/db";
import { getUserByIdQuery } from "../../../utils/user.utils";
import { getRoleNameById } from "../../../utils/roleMap";
import { roleHasPermission } from "../../../utils/rolePermissions.utils";

const mockQuery = sequelize.query as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockGetUser = getUserByIdQuery as unknown as jest.Mock<
  (...args: unknown[]) => Promise<unknown>
>;
const mockRoleName = getRoleNameById as unknown as jest.Mock<
  (...args: unknown[]) => Promise<unknown>
>;
const mockHasPermission = roleHasPermission as unknown as jest.Mock<
  (...args: unknown[]) => Promise<boolean>
>;

const ORG = 7;
const REFUSAL = "You do not have permission to read the audit ledger";
const ROLE_NAMES: Record<number, string> = { 1: "Admin", 3: "Editor" };

const ledgerRow = {
  id: 1,
  entry_type: "event_log",
  user_id: 5,
  occurred_at: "2026-10-17T00:00:00.000Z",
  event_type: "Update",
  entity_type: "risk",
  entity_id: 3,
  action: "update",
  field_name: null,
  old_value: null,
  new_value: null,
  description: "Updated risk",
};

const tools: Array<[string, Record<string, unknown>, string]> = [
  ["fetch_event_logs", {}, "event_logs"],
  ["get_audit_trail_for_entity", { entity_type: "risk", entity_id: 3 }, "audit_entries"],
];

// REST GET /audit-ledger requires auditLedger.super; the advisor tools that
// read the same table must apply the same check to the calling user.
describe("audit ledger advisor tools apply auditLedger.super", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([ledgerRow]);
    mockRoleName.mockImplementation(async (id) => ROLE_NAMES[id as number]);
    mockHasPermission.mockImplementation(
      async (_org, role, key) => role === "Admin" && key === "auditLedger.super",
    );
  });

  describe.each(tools)("%s", (name, params, rowsKey) => {
    const run = (userId?: number) => availableAuditLedgerTools[name](params, ORG, userId);

    it("refuses without a calling user and does not query the ledger", async () => {
      await expect(run(undefined)).resolves.toEqual({ error: REFUSAL });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("refuses a user from another organization", async () => {
      mockGetUser.mockResolvedValue({ id: 5, organization_id: 99, role_id: 1 });
      await expect(run(5)).resolves.toEqual({ error: REFUSAL });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("refuses an Editor and does not query the ledger", async () => {
      mockGetUser.mockResolvedValue({ id: 5, organization_id: ORG, role_id: 3 });
      await expect(run(5)).resolves.toEqual({ error: REFUSAL });
      expect(mockHasPermission).toHaveBeenCalledWith(ORG, "Editor", "auditLedger.super");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("returns ledger rows to a user holding auditLedger.super", async () => {
      mockGetUser.mockResolvedValue({ id: 5, organization_id: ORG, role_id: 1 });
      const result = (await run(5)) as Record<string, unknown>;
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(result[rowsKey]).toHaveLength(1);
    });
  });
});
