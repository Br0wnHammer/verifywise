import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockQuery = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
const mockAppend = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

jest.mock("../../database/db", () => ({
  sequelize: { query: (...args: unknown[]) => mockQuery(...args) },
}));
jest.mock("../auditLedger.utils", () => ({
  appendToAuditLedger: (...args: unknown[]) => mockAppend(...args),
}));

import { logEvent } from "../logger/dbLogger";

// event_logs is served to every org member by GET /api/logger/events, and
// controllers call logEvent directly with `${error.message}`, so the sink
// itself must redact before both writes.
describe("logEvent redaction", () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockAppend.mockClear();
  });

  it("redacts secrets before the event_logs insert and the audit ledger append", async () => {
    await logEvent(
      "Error",
      "Share link failed: upstream said client_secret=abc123 and key sk-abcdefghijklmnop1234",
      5,
      7,
    );

    const [, options] = mockQuery.mock.calls[0] as [
      string,
      { replacements: Record<string, unknown> },
    ];
    const stored = options.replacements.description as string;
    expect(stored).toBe(
      "Share link failed: upstream said client_secret=[REDACTED] and key [REDACTED]",
    );
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ description: stored }));
  });

  it("stores a description without secrets unchanged", async () => {
    await logEvent("Create", "Created vendor Acme", 5, 7);
    const [, options] = mockQuery.mock.calls[0] as [
      string,
      { replacements: Record<string, unknown> },
    ];
    expect(options.replacements.description).toBe("Created vendor Acme");
  });
});
