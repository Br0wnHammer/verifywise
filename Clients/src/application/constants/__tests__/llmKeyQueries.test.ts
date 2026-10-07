import { describe, it, expect } from "vitest";
import { retryLLMKeyQuery } from "../llmKeyQueries";

describe("retryLLMKeyQuery", () => {
  it("retries a server or network failure once", () => {
    expect(retryLLMKeyQuery(0, { status: 500 })).toBe(true);
    expect(retryLLMKeyQuery(0, new Error("Network Error"))).toBe(true);
    expect(retryLLMKeyQuery(1, { status: 500 })).toBe(false);
  });

  it("does not retry a 4xx, which fails the same way again", () => {
    expect(retryLLMKeyQuery(0, { status: 401 })).toBe(false);
    expect(retryLLMKeyQuery(0, { status: 403 })).toBe(false);
    expect(retryLLMKeyQuery(0, { status: 404 })).toBe(false);
  });
});
