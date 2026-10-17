import { describe, it, expect } from "@jest/globals";
import { redactSensitiveInfo } from "../logger/redact";

describe("redactSensitiveInfo", () => {
  it.each([
    // Existing coverage, unchanged.
    ["OpenAI-style key", "key sk-abcdefghijklmnop1234 rejected", "key [REDACTED] rejected"],
    [
      "Authorization Bearer",
      "Authorization: Bearer abc.def.ghi failed",
      "Authorization: Bearer [REDACTED] failed",
    ],
    ["password=", "login password=hunter2 refused", "login password=[REDACTED] refused"],
    ["quoted password=", "login password='hunter2' refused", "login password=[REDACTED] refused"],
    ["camelCase accessToken", "accessToken: abc123 expired", "accessToken=[REDACTED] expired"],
    [
      'JSON "password"',
      '{"password":"hunter2","user":"a"}',
      '{"password":"[REDACTED]","user":"a"}',
    ],
    // snake_case and prefixed keys
    ["client_secret", "client_secret=abc123 is wrong", "client_secret=[REDACTED] is wrong"],
    ["access_token", "access_token: xyz789 expired", "access_token=[REDACTED] expired"],
    ["refresh_token", "refresh_token=r-1 revoked", "refresh_token=[REDACTED] revoked"],
    ["db_password", "db_password=pa55 bad", "db_password=[REDACTED] bad"],
    [
      'JSON "refresh_token"',
      '{"refresh_token":"r-1","ok":false}',
      '{"refresh_token":"[REDACTED]","ok":false}',
    ],
    ['JSON "client_secret"', "{'client_secret': 'abc'}", "{'client_secret':'[REDACTED]'}"],
    // headers
    ["x-api-key header", "x-api-key: abcdef123456 denied", "x-api-key=[REDACTED] denied"],
    // URL credentials keep scheme, user and host
    [
      "URL credentials",
      "connect postgres://admin:s3cr3t@db.internal:5432/vw failed",
      "connect postgres://admin:[REDACTED]@db.internal:5432/vw failed",
    ],
    // bare tokens
    [
      "bare JWT",
      "token eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.c2lnbmF0dXJlLXZhbHVl was invalid",
      "token [REDACTED] was invalid",
    ],
    [
      "GitHub classic token",
      "push with ghp_abcdefghijklmnopqrstuvwxyz0123 failed",
      "push with [REDACTED] failed",
    ],
    [
      "GitHub fine-grained token",
      "use github_pat_11ABCDEFG0123456789_abcdefghijklmnop now",
      "use [REDACTED] now",
    ],
    [
      "Vercel gateway key",
      "gateway key vck_abcdefghij1234567890 rejected",
      "gateway key [REDACTED] rejected",
    ],
  ])("redacts %s", (_label, input, expected) => {
    expect(redactSensitiveInfo(input)).toBe(expected);
  });

  it.each([
    "Created vendor Acme",
    "token budget exceeded for this month",
    "max_tokens=4096 was applied",
    "token_count=12 recorded",
    "Risk 42 updated by user 7",
    "Failed to update risk: risk not found (id=42)",
    "Visit https://verifywise.ai/docs for help",
    "Secret santa planning task created",
  ])("leaves %j unchanged", (input) => {
    expect(redactSensitiveInfo(input)).toBe(input);
  });
});
