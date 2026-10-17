import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockLogEvent = jest
  .fn<
    (
      eventType: string,
      description: string,
      userId: number,
      organizationId: number,
    ) => Promise<void>
  >()
  .mockResolvedValue(undefined);

jest.mock("../logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), debug: jest.fn() },
  logStructured: jest.fn(),
}));

jest.mock("../logger/dbLogger", () => ({
  logEvent: (eventType: string, description: string, userId: number, organizationId: number) =>
    mockLogEvent(eventType, description, userId, organizationId),
}));

import { logFailure, logSuccess } from "../logger/logHelper";

// event_logs rows are served to every org member by GET /api/logger/events,
// so the description must pass through the same redaction as the file log.
describe("logHelper event redaction", () => {
  beforeEach(() => {
    mockLogEvent.mockReset();
    mockLogEvent.mockResolvedValue(undefined);
  });

  it("redacts a secret in the error message before it reaches logEvent", async () => {
    await logFailure({
      eventType: "Create",
      description: "Failed to call provider",
      functionName: "fn",
      fileName: "file.ts",
      userId: 1,
      organizationId: 7,
      error: new Error("401 from upstream with key sk-abcdefghijklmnop1234 and password=hunter2"),
    });

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [eventType, description] = mockLogEvent.mock.calls[0];
    expect(eventType).toBe("Error");
    expect(description).toContain("Failed to call provider: 401 from upstream");
    expect(description).toContain("[REDACTED]");
    expect(description).not.toContain("sk-abcdefghijklmnop1234");
    expect(description).not.toContain("hunter2");
  });

  it("redacts a secret in a success description before it reaches logEvent", async () => {
    await logSuccess({
      eventType: "Update",
      description: "Updated integration with Authorization: Bearer eyJhbGciOi.secret.sig",
      functionName: "fn",
      fileName: "file.ts",
      userId: 1,
      organizationId: 7,
    });

    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const [, description] = mockLogEvent.mock.calls[0];
    expect(description).toBe("Updated integration with Authorization: Bearer [REDACTED]");
  });

  it("leaves a description without secrets unchanged", async () => {
    await logSuccess({
      eventType: "Create",
      description: "Created vendor Acme",
      functionName: "fn",
      fileName: "file.ts",
      userId: 1,
      organizationId: 7,
    });
    expect(mockLogEvent.mock.calls[0][1]).toBe("Created vendor Acme");
  });
});
