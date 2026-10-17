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
    // suffixed key names
    [
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SECRET_ACCESS_KEY=abc set",
      "AWS_SECRET_ACCESS_KEY=[REDACTED] set",
    ],
    ["secret_key", "secret_key=abc set", "secret_key=[REDACTED] set"],
    ["private_key", "private_key=abc set", "private_key=[REDACTED] set"],
    ["passphrase", "passphrase=hunter2 set", "passphrase=[REDACTED] set"],
    // URL credentials, harder shapes
    [
      "password-only URL",
      "redis://:s3cr3tpw@localhost:6379 refused",
      "redis://:[REDACTED]@localhost:6379 refused",
    ],
    [
      "password with /",
      "postgres://user:ab/cd+ef@db:5432/x refused",
      "postgres://user:[REDACTED]@db:5432/x refused",
    ],
    [
      "password with @",
      "postgres://user:p@ss@db/x refused",
      "postgres://user:[REDACTED]@db/x refused",
    ],
    // host:port@ is indistinguishable from user:password@, so it is redacted.
    ["host:port@ (safe side)", "http://host:8080@foo", "http://host:[REDACTED]@foo"],
    // unsigned JWT
    ["JWT with empty signature", "got eyJhbGc.eyJzdWI. back", "got [REDACTED] back"],
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
    "Fetched http://host:8080/path ok",
    "Profile https://example.com/@user linked",
    "Request 3f2b9c1e-1234-4abc-8def-0123456789ab completed",
  ])("leaves %j unchanged", (input) => {
    expect(redactSensitiveInfo(input)).toBe(input);
  });
});

// Redaction runs on every log line and event, so it must stay linear.
// Each input is 50-120KB; a quadratic pattern takes seconds on them (the
// UUID chain took ~1.8s and "a-" x32000 ~8.7s before the bounds). Measured
// locally after the fix (Node 22, best of 3): 0.5-14.3ms each, worst
// "x://a:;" x15000. The bound is the best of three runs,
// so a busy CI machine does not flake it.
describe("redactSensitiveInfo performance", () => {
  const prng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const random = prng(42);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=:/@.\" '{}&,";
  const randomText = Array.from(
    { length: 100_000 },
    () => alphabet[Math.floor(random() * alphabet.length)],
  ).join("");
  const uuids = Array.from(
    { length: 2000 },
    (_, i) =>
      `${((i * 2654435761) >>> 0).toString(16).padStart(8, "0")}-1234-4abc-8def-0123456789ab`,
  ).join("-");

  const bestOfThree = (input: string) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      redactSensitiveInfo(input);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it.each([
    ["2000 UUIDs joined by -", uuids],
    ['"a-" x32000', "a-".repeat(32000)],
    ["100KB random text", randomText],
    ['"eyJ-" x25000', "eyJ-".repeat(25000)],
    ['"sk-" x30000', "sk-".repeat(30000)],
    ['"x://a:" x15000', "x://a:".repeat(15000)],
    ['"x://a:@@" x15000', "x://a:@@".repeat(15000)],
    ['"x://a:;" x15000', "x://a:;".repeat(15000)],
    ['"\\"password\\":\\"" x8000', '"password":"'.repeat(8000)],
    ['"Authorization: " x8000', "Authorization: ".repeat(8000)],
  ])("redacts %s in under 50ms", (_label, input) => {
    expect(bestOfThree(input)).toBeLessThan(50);
  });
});
